import { existsSync } from 'node:fs'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { userInfo } from 'node:os'
import { dirname, join } from 'node:path'
import { setTimeout } from 'node:timers/promises'
import type { Exec } from '../forge/gh.js'
import type { Schedule, Scheduler } from './index.js'

const LABEL = 'awaywork'

/** A user LaunchAgent, started at login and restarted whenever it exits. */
export function launchd(home: string, run: Exec, uid = userInfo().uid, retryMs = 300): Scheduler {
  const file = join(home, 'Library', 'LaunchAgents', `${LABEL}.plist`)
  const bootout = () => run('launchctl', ['bootout', `gui/${uid}/${LABEL}`]).catch(() => '')
  // bootout returns before the old job is gone, and bootstrap fails with EIO until it is.
  const bootstrap = async (tries = 10): Promise<void> => {
    try {
      await run('launchctl', ['bootstrap', `gui/${uid}`, file])
    } catch (e) {
      if (tries <= 1) throw e
      await setTimeout(retryMs)
      await bootstrap(tries - 1)
    }
  }
  return {
    id: 'launchd',
    async install(s) {
      await mkdir(dirname(file), { recursive: true })
      await writeFile(file, plist(s))
      await bootout()
      await bootstrap()
      return file
    },
    async remove() {
      if (!existsSync(file)) return false
      await bootout()
      await rm(file)
      return true
    },
    async read() {
      return existsSync(file) ? parsePlist(await readFile(file, 'utf8')) : undefined
    },
  }
}

export function parsePlist(text: string): Schedule {
  const after = (key: string) => text.split(`<key>${key}</key>`)[1] ?? ''
  const strings = (xml: string) =>
    [...xml.matchAll(/<string>(.*?)<\/string>/g)].map((m) =>
      (m[1] ?? '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&'),
    )
  return {
    command: strings(after('ProgramArguments').split('</array>')[0] ?? ''),
    path: strings(after('PATH'))[0] ?? '',
    log: strings(after('StandardOutPath'))[0] ?? '',
  }
}

export function plist(s: Schedule): string {
  const str = (v: string) =>
    `<string>${v.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')}</string>`
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>${str(LABEL)}
  <key>ProgramArguments</key>
  <array>
${s.command.map((arg) => `    ${str(arg)}`).join('\n')}
  </array>
  <key>EnvironmentVariables</key>
  <dict><key>PATH</key>${str(s.path)}</dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key>${str(s.log)}
  <key>StandardErrorPath</key>${str(s.log)}
</dict>
</plist>
`
}
