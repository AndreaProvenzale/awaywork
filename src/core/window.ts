import type { Config } from '../config/schema.js'

export type Window = Config['windows'][number]

const DAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'] as const

const MINUTE = 60 * 1000
const DAY = 24 * 60 * MINUTE

/** GitHub cancels a job on its hosted runners after 6 hours. */
export const HOSTED_JOB_MINUTES = 360
/** GitHub's 360 default applies to self-hosted runners too; a window is always under 24 hours. */
export const SELF_HOSTED_JOB_MINUTES = 1440
/** How long a run on a GitHub-hosted runner lasts at most, counted from its own start: the rest of the job publishes and reports. */
export const HOSTED_RUN_MINUTES = 340

const clock = (time: string) => time.split(':').map(Number) as [number, number]

/** Where a window opens (local time) as a scheduler trigger, same-time windows merged as launchd reads them back: weekdays are 0 (Sunday) to 6. */
export function startsOf(windows: Window[]): { hour: number; minute: number; days?: number[] }[] {
  const starts: { hour: number; minute: number; days?: number[] }[] = []
  for (const w of windows) {
    const [hour, minute] = clock(w.start)
    const days = w.days?.map((d) => DAYS.indexOf(d))
    const same = starts.find((s) => s.hour === hour && s.minute === minute && !s.days === !days)
    if (same?.days && days) same.days = [...new Set([...same.days, ...days])].sort((a, b) => a - b)
    else
      starts.push({ hour, minute, ...(days && { days: [...new Set(days)].sort((a, b) => a - b) }) })
  }
  return starts
}

/** Each window opening from the day before `from` to `days` days after, as [start, end]; one may cross midnight. */
function occurrences(windows: Window[], from: Date, days: number): [Date, Date][] {
  const found: [Date, Date][] = []
  for (let offset = -1; offset <= days; offset++) {
    const day = new Date(from)
    day.setDate(day.getDate() + offset)
    for (const w of windows) {
      if (w.days && !w.days.includes(DAYS[day.getDay()] as (typeof DAYS)[number])) continue
      const [start, end] = [new Date(day), new Date(day)]
      start.setHours(...clock(w.start), 0, 0)
      end.setHours(...clock(w.end), 0, 0)
      if (end <= start) end.setDate(end.getDate() + 1)
      found.push([start, end])
    }
  }
  return found
}

/** When the window `now` (local time) is in ends, or undefined when it is in none. */
export function windowEnd(windows: Window[], now: Date): Date | undefined {
  const open = occurrences(windows, now, 0).filter(([start, end]) => start <= now && now < end)
  return open.length ? new Date(Math.max(...open.map(([, end]) => end.getTime()))) : undefined
}

/** When a run started at `now` must stop on a GitHub-hosted runner, or undefined elsewhere. */
export const hostedEnd = (now: Date, env: NodeJS.ProcessEnv) =>
  env.RUNNER_ENVIRONMENT === 'github-hosted'
    ? new Date(now.getTime() + HOSTED_RUN_MINUTES * MINUTE)
    : undefined

/** When a scheduled run started at `now` stops: its window's end, or sooner on a GitHub-hosted runner. */
export function runEnd(windows: Window[], now: Date, env: NodeJS.ProcessEnv): Date | undefined {
  const end = windowEnd(windows, now)
  const cap = hostedEnd(now, env)
  return end && cap && cap < end ? cap : end
}

const minutesOf = (time: string) => clock(time)[0] * 60 + clock(time)[1]

/** The windows longer than a GitHub-hosted runner's job, which a run there can't reach the end of. */
export const tooLongForHosted = (windows: Window[]) =>
  windows.filter(
    (w) => (minutesOf(w.end) - minutesOf(w.start) + 24 * 60) % (24 * 60) > HOSTED_JOB_MINUTES,
  )

/** Windows still to open or running between `now` and `until` (epoch ms), at least one. */
export function runsLeft(windows: Window[], now: number, until: number): number {
  const days = Math.ceil((until - now) / DAY) + 1
  const left = occurrences(windows, new Date(now), days).filter(
    ([start, end]) => end.getTime() > now && start.getTime() < until,
  )
  return Math.max(1, left.length)
}

/** The first window opening at or after `from` and before `until` (epoch ms), or undefined. */
function firstOpening(windows: Window[], from: number, until: number): number | undefined {
  const days = Math.ceil((until - from) / DAY) + 1
  const starts = occurrences(windows, new Date(from), days)
    .map(([start]) => start.getTime())
    .filter((start) => start >= from && start < until)
  return starts.length ? Math.min(...starts) : undefined
}

/** The first opening before `until` (epoch ms) at or after the end of the window `now` is in, or of the next one to open: a run's next turn. */
export function nextOpening(windows: Window[], now: number, until: number): number | undefined {
  const start = windowEnd(windows, new Date(now)) ? now : firstOpening(windows, now, until)
  const end = start === undefined ? undefined : windowEnd(windows, new Date(start))
  return end && firstOpening(windows, end.getTime(), until)
}

/** E.g. `01:00-07:00` or `sat,sun 10:00-18:00`. */
export const describeWindow = (w: Window) =>
  `${w.days ? `${w.days.join(',')} ` : ''}${w.start}-${w.end}`
