import { existsSync } from 'node:fs'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Exec } from '../forge/gh.js'
import { describeStarts, type Start } from './index.js'
import { onCalendar } from './systemd.js'

const UNIT = 'awaywork-wake'
const UNIT_DIR = '/etc/systemd/system'
const PMSET_DAYS = 'MTWRFSU'

const systemdRuns = () => existsSync('/run/systemd/system')
const pad = (n: number) => String(n).padStart(2, '0')

/** Holds the machine awake while a run lasts; after a scheduled wake it sleeps again within minutes. */
export async function keepAwake(run: Exec, platform = process.platform): Promise<string[]> {
  if (platform === 'darwin') return ['/usr/bin/caffeinate', '-i']
  if (platform !== 'linux') return []
  const args = ['--what=idle', '--who=awaywork', '--why=scheduled run']
  // Without systemd or a system D-Bus, systemd-inhibit fails before the run starts.
  return run('systemd-inhibit', [...args, 'true']).then(
    () => ['systemd-inhibit', ...args],
    () => [],
  )
}

/** Wakes the machine from sleep when a window opens; root sets it, so it goes through sudo. */
export interface Wake {
  question: string
  /** The answer Enter gives: no when it replaces power events already set. */
  initial: boolean
  install(): Promise<void>
}

/** The wake this machine can set for the starts, a reason when it cannot, or none. */
export async function wakeFor(
  starts: Start[],
  run: Exec,
  platform = process.platform,
): Promise<Wake | string | undefined> {
  if (platform === 'darwin') return pmsetWake(starts, run)
  if (platform === 'linux' && systemdRuns()) return timerWake(starts, run)
  return undefined
}

/** The wake left set and the command removing it; sudo asks for a password, so the user runs it. */
export async function wakeUndo(
  run: Exec,
  platform = process.platform,
): Promise<string | undefined> {
  if (platform === 'darwin') {
    const events = await repeating(run)
    return events
      ? `Repeating power events stay (${events}); \`sudo pmset repeat cancel\` removes them all`
      : undefined
  }
  if (existsSync(join(UNIT_DIR, `${UNIT}.timer`)))
    return `A repeating wake stays; \`sudo systemctl disable --now ${UNIT}.timer && sudo rm ${UNIT_DIR}/${UNIT}.{service,timer}\` removes it`
  return undefined
}

/** `pmset repeat` args for the starts; undefined when they differ in time, as pmset repeats one. */
export function pmsetArgs(starts: Start[]): string[] | undefined {
  const [first] = starts
  if (!first || starts.some((s) => s.hour !== first.hour || s.minute !== first.minute))
    return undefined
  const days = new Set(starts.flatMap((s) => s.days ?? [0, 1, 2, 3, 4, 5, 6]))
  const letters = [...PMSET_DAYS].filter((_, i) => days.has((i + 1) % 7)).join('')
  return ['pmset', 'repeat', 'wake', letters, `${pad(first.hour)}:${pad(first.minute)}:00`]
}

/** The repeating power events pmset has, joined by "; ". */
const repeating = async (run: Exec) =>
  (await run('pmset', ['-g', 'sched']).catch(() => ''))
    .match(/Repeating power events:\n((?:[ \t]+.*(?:\n|$))+)/)?.[1]
    ?.trim()
    .split('\n')
    .map((l) => l.trim())
    .join('; ')

async function pmsetWake(starts: Start[], run: Exec): Promise<Wake | string> {
  const args = pmsetArgs(starts)
  if (!args)
    return `pmset repeats one wake time and the windows start at ${describeStarts(starts)}; keep this Mac awake for them`
  const current = await repeating(run)
  return {
    question: `Wake this Mac when the window opens (sudo ${args.join(' ')}${current ? `, replacing ${current}` : ''})?`,
    initial: !current,
    install: async () => void (await run('sudo', args)),
  }
}

export const wakeTimer = (starts: Start[]) => `[Unit]
Description=Wake for awaywork runs

[Timer]
${onCalendar(starts)}
WakeSystem=true

[Install]
WantedBy=timers.target
`

const WAKE_SERVICE = `[Unit]
Description=Wake for awaywork runs

[Service]
Type=oneshot
ExecStart=true
`

export function timerWake(starts: Start[], run: Exec): Wake {
  return {
    question: `Wake this machine from suspend when a window opens (sudo, ${UNIT_DIR}/${UNIT}.timer with WakeSystem=true)?`,
    initial: true,
    async install() {
      const dir = await mkdtemp(join(tmpdir(), 'awaywork-'))
      try {
        const [service, timer] = [join(dir, `${UNIT}.service`), join(dir, `${UNIT}.timer`)]
        await writeFile(service, WAKE_SERVICE)
        await writeFile(timer, wakeTimer(starts))
        await run('sudo', ['install', '-m', '644', service, timer, UNIT_DIR])
        await run('sudo', ['systemctl', 'daemon-reload'])
        await run('sudo', ['systemctl', 'enable', '--now', `${UNIT}.timer`])
      } finally {
        await rm(dir, { recursive: true, force: true })
      }
    },
  }
}
