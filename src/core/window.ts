import type { Config } from '../config/schema.js'

export type Window = NonNullable<Config['windows']>[number]

export const DAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'] as const

const DAY = 24 * 60 * 60 * 1000

export const clock = (time: string) => time.split(':').map(Number) as [number, number]

/** `windows` when set, else the single `night` window. */
export const windowsOf = ({ night, windows }: Pick<Config, 'night' | 'windows'>): Window[] =>
  windows ?? [night]

/** Where a window opens (local time) as a scheduler trigger, same-time windows merged as launchd reads them back: weekdays are 0 (Sunday) to 6. */
export function startsOf(windows: Window[]): { hour: number; minute: number; days?: number[] }[] {
  const starts: { hour: number; minute: number; days?: number[] }[] = []
  for (const w of windows) {
    const [hour, minute] = clock(w.start)
    const days = w.days?.map((d) => DAYS.indexOf(d))
    const same = starts.find((s) => s.hour === hour && s.minute === minute && !s.days === !days)
    if (same?.days && days) same.days = [...new Set([...same.days, ...days])].sort()
    else starts.push({ hour, minute, ...(days && { days: days.sort() }) })
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
export function nightEnd(windows: Window[], now: Date): Date | undefined {
  const open = occurrences(windows, now, 0).filter(([start, end]) => start <= now && now < end)
  return open.length ? new Date(Math.max(...open.map(([, end]) => end.getTime()))) : undefined
}

/** Windows still to open or running between `now` and `until` (epoch ms), at least one. */
export function runsLeft(windows: Window[], now: number, until: number): number {
  const days = Math.ceil((until - now) / DAY) + 1
  const left = occurrences(windows, new Date(now), days).filter(
    ([start, end]) => end.getTime() > now && start.getTime() < until,
  )
  return Math.max(1, left.length)
}

/** E.g. `01:00-07:00` or `sat,sun 10:00-18:00`. */
export const describeWindow = (w: Window) =>
  `${w.days ? `${w.days.join(',')} ` : ''}${w.start}-${w.end}`
