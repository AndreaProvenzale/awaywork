import { mkdir, rm, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { readJson } from '#util/json'
import { untilTime } from './skips'

interface Pause {
  /** A local date, `YYYY-MM-DD`; the pause ends when that day starts. */
  until: string
}

export async function savePause(path: string, pause: Pause): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, `${JSON.stringify(pause)}\n`)
}

export const clearPause = (path: string) => rm(path, { force: true })

/** The date the pause in force ends, or undefined when there is none or it has expired. */
export async function pausedUntil(path: string, now = Date.now()): Promise<string | undefined> {
  const { until } = await readJson<Partial<Pause>>(path, {})
  return until && (untilTime(until) ?? 0) > now ? until : undefined
}

export const pausedLine = (until: string) => `paused until ${until} (awaywork resume to undo)`
