import { existsSync } from 'node:fs'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Exec } from '../forge/gh.js'
import { type Schedule, type Scheduler, SchedulerError, type Start } from './index.js'

/** A user service started at login and restarted whenever it exits. */
export function systemd(home: string, run: Exec): Scheduler {
  const dir = join(home, '.config', 'systemd', 'user')
  const file = join(dir, 'awaywork.service')
  // The trigger per window an older awaywork installed.
  const timerFile = join(dir, 'awaywork.timer')
  const systemctl = (...args: string[]) => run('systemctl', ['--user', ...args])
  const removeTimer = async () => {
    if (!existsSync(timerFile)) return
    await systemctl('disable', '--now', 'awaywork.timer').catch(() => '')
    await rm(timerFile, { force: true })
  }
  return {
    id: 'systemd',
    async install(s) {
      await mkdir(dir, { recursive: true })
      const previous = await readFile(file, 'utf8').catch(() => undefined)
      await writeFile(file, service(s))
      try {
        await removeTimer()
        await systemctl('daemon-reload')
        await systemctl('enable', 'awaywork.service')
        await systemctl('restart', 'awaywork.service')
      } catch (e) {
        if (previous === undefined) await rm(file, { force: true })
        else await writeFile(file, previous)
        await systemctl('daemon-reload').catch(() => '')
        const { stderr } = e as { stderr?: string }
        const reason = (stderr?.trim() || (e instanceof Error ? e.message : String(e))).split(
          '\n',
        )[0]
        throw new SchedulerError(
          `systemctl failed (${reason}); without a systemd user session, log in directly or use --with cron`,
          { cause: e },
        )
      }
      return file
    },
    async remove() {
      if (!existsSync(file)) return false
      await removeTimer()
      await systemctl('disable', '--now', 'awaywork.service').catch(() => '')
      await rm(file, { force: true })
      await systemctl('daemon-reload').catch(() => '')
      return true
    },
    async read() {
      if (!existsSync(file)) return undefined
      const unit = existsSync(timerFile) ? 'awaywork.timer' : 'awaywork.service'
      const enabled = await systemctl('is-enabled', unit).then(
        () => true,
        () => false,
      )
      return enabled ? parseService(await readFile(file, 'utf8')) : undefined
    },
  }
}

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

const quote = (v: string) => `"${v.replace(/[\\"]/g, '\\$&').replace(/%/g, '%%')}"`

export function parseService(text: string): Schedule {
  const value = (text: string, key: string) =>
    text.match(new RegExp(`^${key}=(.*)$`, 'm'))?.[1] ?? ''
  const unquote = (line: string) =>
    [...line.matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((m) =>
      (m[1] ?? '').replace(/\\(.)/g, '$1').replace(/%%/g, '%'),
    )
  return {
    command: unquote(value(text, 'ExecStart')),
    path: (unquote(value(text, 'Environment'))[0] ?? '').replace(/^PATH=/, ''),
    log: value(text, 'StandardOutput').replace(/^append:/, ''),
  }
}

export function service(s: Schedule): string {
  return `[Unit]
Description=awaywork watch

[Service]
Environment=${quote(`PATH=${s.path}`)}
ExecStart=${s.command.map(quote).join(' ')}
Restart=always
RestartSec=10
StandardOutput=append:${s.log}
StandardError=append:${s.log}

[Install]
WantedBy=default.target
`
}

export const onCalendar = (starts: Start[]) =>
  starts
    .map(
      (start) =>
        `OnCalendar=${start.days ? `${start.days.map((d) => WEEKDAYS[d]).join(',')} ` : ''}*-*-* ${pad(start.hour)}:${pad(start.minute)}:00`,
    )
    .join('\n')

const pad = (n: number) => String(n).padStart(2, '0')
