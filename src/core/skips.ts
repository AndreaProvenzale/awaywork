export interface Skip {
  /** A local date, `YYYY-MM-DD`; the skip ends when that day starts. */
  until?: string
  reason?: string
}

/** The start of `until`'s day in local time, or undefined when it is not a `YYYY-MM-DD` date. */
export function untilTime(until: string): number | undefined {
  const time = new Date(`${until}T00:00`).getTime()
  return /^\d{4}-\d{2}-\d{2}$/.test(until) && !Number.isNaN(time) ? time : undefined
}

/** Skips still in force at `now`, by item key. */
export function activeSkips(
  entries: Record<string, { skip?: Skip }>,
  now: number,
): Record<string, Skip> {
  const skips: Record<string, Skip> = {}
  for (const [key, { skip }] of Object.entries(entries))
    if (skip && (!skip.until || (untilTime(skip.until) ?? 0) > now)) skips[key] = skip
  return skips
}

/** E.g. `skipped with nightshift skip acme/api#5 until 2026-10-05: flaky upstream`. */
export function describeSkip(key: string, skip: Skip): string {
  const until = skip.until ? ` until ${skip.until}` : ''
  return `skipped with nightshift skip ${key}${until}${skip.reason ? `: ${skip.reason}` : ''}`
}
