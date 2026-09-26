import type { Config } from '../config/schema.js'

type Night = Config['night']

export const clock = (time: string) => time.split(':').map(Number) as [number, number]

/** When tonight's window ends, or undefined when `now` (local time) is outside it; it may cross midnight. */
export function nightEnd(night: Night, now: Date): Date | undefined {
  const minutes = (time: string) => clock(time)[0] * 60 + clock(time)[1]
  const [start, end, at] = [
    minutes(night.start),
    minutes(night.end),
    now.getHours() * 60 + now.getMinutes(),
  ]
  const inside = start < end ? start <= at && at < end : at >= start || at < end
  if (!inside) return undefined
  const [hour, minute] = clock(night.end)
  const until = new Date(now)
  until.setHours(hour, minute, 0, 0)
  if (until <= now) until.setDate(until.getDate() + 1)
  return until
}
