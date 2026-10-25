import { lstat, readdir, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { attemptsPath, runLockPath, runsDir } from '../config/paths.js'
import type { Config } from '../config/schema.js'
import { loadAttempts } from './attempts.js'
import { spanMs } from './queue.js'

export interface Pruned {
  removed: number
  bytes: number
  /** A line per run dir that couldn't be removed. */
  failures: string[]
}

/**
 * Removes the run dirs that started longer than `keep_runs` before `now`, going by the run id, a
 * UTC start time. Keeps the run holding the run lock, every run attempts.json reads an item's
 * latest report from, and anything not named like a run.
 */
export async function pruneRuns(config: Pick<Config, 'keep_runs'>, now: Date): Promise<Pruned> {
  const cutoff = now.getTime() - spanMs(config.keep_runs)
  const kept = new Set(
    Object.values(await loadAttempts(attemptsPath)).flatMap((a) => a.report?.runId ?? []),
  )
  const locked = (await readFile(runLockPath, 'utf8').catch(() => '')).split(' ')[1]
  if (locked) kept.add(locked)
  const pruned: Pruned = { removed: 0, bytes: 0, failures: [] }
  for (const id of await readdir(runsDir).catch(() => [])) {
    const started = runStart(id)
    if (started === undefined || started >= cutoff || kept.has(id)) continue
    const dir = join(runsDir, id)
    const bytes = await sizeOf(dir)
    try {
      await rm(dir, { recursive: true, force: true })
      pruned.removed++
      pruned.bytes += bytes
    } catch (e) {
      pruned.failures.push(`couldn't remove old run ${dir}: ${(e as Error).message}`)
    }
  }
  return pruned
}

/** The start of a run named `YYYYMMDD-HHMMSS`, in UTC, or undefined for any other name. */
function runStart(id: string): number | undefined {
  const m = /^(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})$/.exec(id)
  if (!m) return undefined
  const [y = 0, mo = 1, d, h, mi, s] = m.slice(1).map(Number)
  return Date.UTC(y, mo - 1, d, h, mi, s)
}

async function sizeOf(path: string): Promise<number> {
  try {
    const stat = await lstat(path)
    if (!stat.isDirectory()) return stat.size
    let bytes = 0
    for (const entry of await readdir(path)) bytes += await sizeOf(join(path, entry))
    return bytes
  } catch {
    return 0
  }
}
