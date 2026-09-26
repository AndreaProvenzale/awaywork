import { existsSync } from 'node:fs'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Exec } from '../forge/gh.js'
import type { Schedule, Scheduler } from './index.js'

/** A user service plus a persistent timer, so a run missed while off starts at boot. */
export function systemd(home: string, run: Exec): Scheduler {
  const dir = join(home, '.config', 'systemd', 'user')
  const files = [join(dir, 'nightshift.service'), join(dir, 'nightshift.timer')] as const
  const systemctl = (...args: string[]) => run('systemctl', ['--user', ...args])
  return {
    id: 'systemd',
    async install(s) {
      await mkdir(dir, { recursive: true })
      await writeFile(files[0], service(s))
      await writeFile(files[1], timer(s))
      await systemctl('daemon-reload')
      await systemctl('enable', '--now', 'nightshift.timer')
      return files.join(', ')
    },
    async remove() {
      if (!existsSync(files[1])) return false
      await systemctl('disable', '--now', 'nightshift.timer').catch(() => '')
      for (const file of files) await rm(file, { force: true })
      await systemctl('daemon-reload')
      return true
    },
  }
}

const quote = (v: string) => `"${v.replace(/[\\"]/g, '\\$&').replace(/%/g, '%%')}"`

export function service(s: Schedule): string {
  return `[Unit]
Description=night-shift run

[Service]
Type=oneshot
Environment=${quote(`PATH=${s.path}`)}
ExecStart=${s.command.map(quote).join(' ')}
StandardOutput=append:${s.log}
StandardError=append:${s.log}
`
}

export function timer(s: Schedule): string {
  const at = `${String(s.hour).padStart(2, '0')}:${String(s.minute).padStart(2, '0')}:00`
  return `[Unit]
Description=night-shift nightly run

[Timer]
OnCalendar=*-*-* ${at}
Persistent=true

[Install]
WantedBy=timers.target
`
}
