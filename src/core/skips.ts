import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

export interface Skip {
  /** A local date, `YYYY-MM-DD`; the skip ends when that day starts. */
  until?: string
  reason?: string
}

/** Per item, by `source:key`. */
export type Skips = Record<string, Skip>

export async function loadSkips(path: string): Promise<Skips> {
  const text = await readFile(path, 'utf8').catch(() => '{}')
  try {
    return JSON.parse(text) as Skips
  } catch {
    return {}
  }
}

export async function saveSkips(path: string, skips: Skips): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, `${JSON.stringify(skips, null, 2)}\n`)
}

/** The start of `until`'s day in local time, or undefined when it is not a real `YYYY-MM-DD` date. */
export function untilTime(until: string): number | undefined {
  const day = new Date(`${until}T00:00`)
  const pad = (n: number) => String(n).padStart(2, '0')
  const roundTrip = `${day.getFullYear()}-${pad(day.getMonth() + 1)}-${pad(day.getDate())}`
  return roundTrip === until ? day.getTime() : undefined
}

/** Skips still in force at `now`. */
export function activeSkips(skips: Skips, now: number): Skips {
  return Object.fromEntries(
    Object.entries(skips).filter(([, s]) => !s.until || (untilTime(s.until) ?? 0) > now),
  )
}

/** E.g. `skipped with awaywork skip github:acme/api#5 until 2026-10-05: flaky upstream`. */
export function describeSkip(key: string, skip: Skip): string {
  const until = skip.until ? ` until ${skip.until}` : ''
  return `skipped with awaywork skip ${key}${until}${skip.reason ? `: ${skip.reason}` : ''}`
}
