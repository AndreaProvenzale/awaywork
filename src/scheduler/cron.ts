import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DEFAULT_PROFILE } from '#config/profiles'
import type { Exec } from '#forge/gh'
import type { Schedule, Scheduler } from './index'

const tagOf = (profile: string) =>
  profile === DEFAULT_PROFILE ? '# awaywork' : `# awaywork:${profile}`

/** Tagged lines in the user's crontab starting the job at boot and every 5 minutes, per profile; the watch lock makes extra copies exit. */
export function cron(run: Exec, profile = DEFAULT_PROFILE): Scheduler {
  const tag = tagOf(profile)
  const read = () => run('crontab', ['-l']).catch(() => '')
  const write = async (lines: string[]) => {
    const dir = await mkdtemp(join(tmpdir(), 'awaywork-'))
    try {
      await writeFile(join(dir, 'crontab'), lines.map((l) => `${l}\n`).join(''))
      await run('crontab', [join(dir, 'crontab')])
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  }
  const lines = (text: string) => (text ? text.replace(/\n+$/, '').split('\n') : [])
  const others = (text: string) => lines(text).filter((l) => !l.endsWith(tag))
  return {
    id: 'cron',
    async install(s) {
      await write([...others(await read()), ...cronLines(s, profile)])
      return 'crontab'
    },
    async remove() {
      const text = await read()
      const kept = others(text)
      if (kept.length === lines(text).length) return false
      await write(kept)
      return true
    },
    async read() {
      const ours = lines(await read()).filter((l) => l.endsWith(tag))
      return ours.length ? parseCronLines(ours) : undefined
    },
  }
}

export function cronLines(s: Schedule, profile = DEFAULT_PROFILE): string[] {
  const q = (v: string) => `'${v.replace(/'/g, `'\\''`)}'`.replace(/%/g, '\\%')
  const command = `PATH=${q(s.path)} ${profile === DEFAULT_PROFILE ? '' : `AWAYWORK_PROFILE=${profile} `}${s.command.map(q).join(' ')} > /dev/null 2>> ${q(s.log)} &`
  return ['@reboot', '*/5 * * * *'].map((when) => `${when} ${command} ${tagOf(profile)}`)
}

export function parseCronLines(ours: string[]): Schedule {
  const words = [...(ours[0] ?? '').replace(/\\%/g, '%').matchAll(/'((?:[^']|'\\'')*)'/g)].map(
    (m) => (m[1] ?? '').replace(/'\\''/g, "'"),
  )
  return {
    command: words.slice(1, -1),
    path: words[0] ?? '',
    log: words.at(-1) ?? '',
  }
}
