import { existsSync } from 'node:fs'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { userInfo } from 'node:os'
import { dirname, join } from 'node:path'
import type { Exec } from '../forge/gh.js'
import type { Schedule, Scheduler } from './index.js'

const LABEL = 'nightshift'

/** A user LaunchAgent; launchd starts a run missed during sleep at the next wake. */
export function launchd(home: string, run: Exec, uid = userInfo().uid): Scheduler {
  const file = join(home, 'Library', 'LaunchAgents', `${LABEL}.plist`)
  const bootout = () => run('launchctl', ['bootout', `gui/${uid}/${LABEL}`]).catch(() => '')
  return {
    id: 'launchd',
    async install(s) {
      await mkdir(dirname(file), { recursive: true })
      await writeFile(file, plist(s))
      await bootout()
      await run('launchctl', ['bootstrap', `gui/${uid}`, file])
      return file
    },
    async remove() {
      if (!existsSync(file)) return false
      await bootout()
      await rm(file)
      return true
    },
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
  <key>StartCalendarInterval</key>
  <dict><key>Hour</key><integer>${s.hour}</integer><key>Minute</key><integer>${s.minute}</integer></dict>
  <key>StandardOutPath</key>${str(s.log)}
  <key>StandardErrorPath</key>${str(s.log)}
</dict>
</plist>
`
}
