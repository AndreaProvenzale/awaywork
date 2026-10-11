import { existsSync } from 'node:fs'
import type { Exec } from '../forge/gh.js'
import { cron } from './cron.js'
import { launchd } from './launchd.js'
import { systemd } from './systemd.js'

/** A time of day (local) a job starts, on the given weekdays (0 is Sunday) or every day. */
export interface Start {
  hour: number
  minute: number
  days?: number[]
}

/** A nightly job: the command, when it starts (local time), its PATH and its log file. */
export interface Schedule {
  command: string[]
  starts: Start[]
  path: string
  log: string
}

export interface Scheduler {
  id: string
  /** Installs or replaces the job; returns where it lives. */
  install(s: Schedule): Promise<string>
  /** Removes the job; false when none was installed. */
  remove(): Promise<boolean>
  /** The installed job, or undefined when none is. */
  read(): Promise<Schedule | undefined>
}

export const schedulers = (home: string, run: Exec): Record<string, Scheduler> => ({
  launchd: launchd(home, run),
  systemd: systemd(home, run),
  cron: cron(run),
})

export function defaultScheduler(platform = process.platform): string {
  if (platform === 'darwin') return 'launchd'
  return existsSync('/run/systemd/system') ? 'systemd' : 'cron'
}

const pad = (n: number) => String(n).padStart(2, '0')

/** E.g. `01:00, 10:00 on 0,6`. */
export const describeStarts = (starts: Start[]) =>
  starts
    .map((s) => `${pad(s.hour)}:${pad(s.minute)}${s.days ? ` on ${s.days.join(',')}` : ''}`)
    .join(', ')
