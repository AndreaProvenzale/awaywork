import { existsSync } from 'node:fs'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { DEFAULT_PROFILE } from '#config/profiles'
import type { Exec } from '#forge/gh'
import { errorText } from '#util/text'
import { SchedulerError } from './error'
import type { Schedule, Scheduler } from './index'

/** A user service started at login and restarted when it crashes; one per profile. */
export function systemd(home: string, run: Exec, profile = DEFAULT_PROFILE): Scheduler {
  const name = profile === DEFAULT_PROFILE ? 'awaywork' : `awaywork-${profile}`
  const dir = join(home, '.config', 'systemd', 'user')
  const file = join(dir, `${name}.service`)
  // The trigger per window an older awaywork installed.
  const timerFile = join(dir, `${name}.timer`)
  const systemctl = (...args: string[]) => run('systemctl', ['--user', ...args])
  const removeTimer = async () => {
    if (!existsSync(timerFile)) return
    await systemctl('disable', '--now', `${name}.timer`).catch(() => '')
    await rm(timerFile, { force: true })
  }
  return {
    id: 'systemd',
    async install(s) {
      await mkdir(dir, { recursive: true })
      const previous = await readFile(file, 'utf8').catch(() => undefined)
      await writeFile(file, service(s, profile))
      try {
        await removeTimer()
        await systemctl('daemon-reload')
        await systemctl('enable', `${name}.service`)
        await systemctl('restart', `${name}.service`)
      } catch (e) {
        if (previous === undefined) await rm(file, { force: true })
        else await writeFile(file, previous)
        await systemctl('daemon-reload').catch(() => '')
        const { stderr } = e as { stderr?: string }
        const reason = (stderr?.trim() || errorText(e)).split('\n')[0]
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
      await systemctl('disable', '--now', `${name}.service`).catch(() => '')
      await rm(file, { force: true })
      await systemctl('daemon-reload').catch(() => '')
      return true
    },
    async read() {
      if (!existsSync(file)) return undefined
      const unit = existsSync(timerFile) ? `${name}.timer` : `${name}.service`
      const enabled = await systemctl('is-enabled', unit).then(
        () => true,
        () => false,
      )
      return enabled ? parseService(await readFile(file, 'utf8')) : undefined
    },
  }
}

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
    unpinned: text.includes('AWAYWORK_PROFILE=') ? undefined : true,
  }
}

export function service(s: Schedule, profile = DEFAULT_PROFILE): string {
  const profileEnv = `Environment=${quote(`AWAYWORK_PROFILE=${profile}`)}\n`
  return `[Unit]
Description=awaywork watch

[Service]
Environment=${quote(`PATH=${s.path}`)}
${profileEnv}ExecStart=${s.command.map(quote).join(' ')}
Restart=on-failure
RestartSec=10
KillMode=mixed
TimeoutStopSec=120
StandardOutput=append:${s.log}
StandardError=append:${s.log}

[Install]
WantedBy=default.target
`
}
