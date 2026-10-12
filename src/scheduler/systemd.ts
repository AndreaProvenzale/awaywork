import { existsSync } from 'node:fs'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Exec } from '../forge/gh.js'
import type { Schedule, Scheduler } from './index.js'

/** A user service plus a persistent timer, so a run missed while off starts at boot. */
export function systemd(home: string, run: Exec): Scheduler {
  const dir = join(home, '.config', 'systemd', 'user')
  const files = [join(dir, 'awaywork.service'), join(dir, 'awaywork.timer')] as const
  const systemctl = (...args: string[]) => run('systemctl', ['--user', ...args])
  return {
    id: 'systemd',
    async install(s) {
      await mkdir(dir, { recursive: true })
      await writeFile(files[0], service(s))
      await writeFile(files[1], timer(s))
      await systemctl('daemon-reload')
      await systemctl('enable', '--now', 'awaywork.timer')
      return files.join(', ')
    },
    async remove() {
      if (!existsSync(files[1])) return false
      await systemctl('disable', '--now', 'awaywork.timer').catch(() => '')
      for (const file of files) await rm(file, { force: true })
      await systemctl('daemon-reload')
      return true
    },
    async read() {
      if (!existsSync(files[1])) return undefined
      return parseUnits(await readFile(files[0], 'utf8'), await readFile(files[1], 'utf8'))
    },
  }
}

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

const quote = (v: string) => `"${v.replace(/[\\"]/g, '\\$&').replace(/%/g, '%%')}"`

export function parseUnits(serviceText: string, timerText: string): Schedule {
  const value = (text: string, key: string) =>
    text.match(new RegExp(`^${key}=(.*)$`, 'm'))?.[1] ?? ''
  const unquote = (line: string) =>
    [...line.matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((m) =>
      (m[1] ?? '').replace(/\\(.)/g, '$1').replace(/%%/g, '%'),
    )
  const starts = [
    ...timerText.matchAll(/^OnCalendar=(?:([A-Za-z,]+) )?\*-\*-\* (\d+):(\d+)/gm),
  ].map(([, days, hour, minute]) => ({
    hour: Number(hour),
    minute: Number(minute),
    ...(days && { days: days.split(',').map((d) => WEEKDAYS.indexOf(d)) }),
  }))
  return {
    command: unquote(value(serviceText, 'ExecStart')),
    starts,
    path: (unquote(value(serviceText, 'Environment'))[0] ?? '').replace(/^PATH=/, ''),
    log: value(serviceText, 'StandardOutput').replace(/^append:/, ''),
  }
}

export function service(s: Schedule): string {
  return `[Unit]
Description=awaywork run

[Service]
Type=oneshot
Environment=${quote(`PATH=${s.path}`)}
ExecStart=${s.command.map(quote).join(' ')}
StandardOutput=append:${s.log}
StandardError=append:${s.log}
`
}

export function timer(s: Schedule): string {
  const pad = (n: number) => String(n).padStart(2, '0')
  const calendar = s.starts.map(
    (start) =>
      `OnCalendar=${start.days ? `${start.days.map((d) => WEEKDAYS[d]).join(',')} ` : ''}*-*-* ${pad(start.hour)}:${pad(start.minute)}:00`,
  )
  return `[Unit]
Description=awaywork scheduled run

[Timer]
${calendar.join('\n')}
Persistent=true

[Install]
WantedBy=timers.target
`
}
