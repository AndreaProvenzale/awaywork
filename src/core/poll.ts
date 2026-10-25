import type { Config } from '../config/schema.js'
import type { Attempts } from './attempts.js'
import type { RunPlan, Skipped } from './foreman.js'
import { spanMs } from './queue.js'
import type { Item } from './types.js'

const MINUTE = 60_000
const HOUR = 60 * MINUTE

/** A failed HTTP call's error, with the wait a 429's `Retry-After` (seconds) asks for in `retryAfter`, in ms. */
export function httpError(message: string, res: Response): Error & { retryAfter?: number } {
  const wait = res.status === 429 ? Number(res.headers.get('retry-after')) : Number.NaN
  return Object.assign(new Error(message), wait > 0 ? { retryAfter: wait * 1000 } : {})
}

/** A source's poll state in awaywork watch: when it's next due, and the failed polls in a row. */
export interface Poll {
  next: number
  failures?: number
}

/** The sources the `run: soon` rules read, each with its interval in ms: its own `every`, or `watch.every` when that's longer. */
export function soonSources(config: Config): Record<string, number> {
  const soon = (config.queue ?? []).filter((r) => r.run === 'soon')
  const ids = Object.keys(config.sources).filter((id) =>
    soon.some((r) => !r.source || r.source === id),
  )
  const base = spanMs(config.watch.every)
  return Object.fromEntries(
    ids.map((id) => {
      const own = (config.sources[id] as { every?: string }).every
      return [id, Math.max(base, own ? spanMs(own) : 0)]
    }),
  )
}

/**
 * The poll after one that ended at `now`, on the daemon's minute ticks: an interval on from the
 * minute it ran in; after a failure, as long as the source's `Retry-After` asks, else the interval
 * doubled per failure in a row up to an hour, never shorter than the interval.
 */
export function nextPoll(
  every: number,
  now: number,
  failed?: { failures: number; retryAfter?: number },
): Poll {
  const tick = now - (now % MINUTE)
  if (!failed) return { next: tick + every }
  const asked = failed.retryAfter && Math.ceil((now + failed.retryAfter) / MINUTE) * MINUTE
  const doubled = tick + Math.min(every * 2 ** failed.failures, HOUR)
  return { next: Math.max(tick + every, asked || doubled), failures: failed.failures }
}

const itemKey = (i: Pick<Item, 'source' | 'key'>) => `${i.source}:${i.key}`
const updatedOf = (i: Item) => String(i.fields.updated ?? '')

/** Each item's updated time when a run last took it, and when, by `source:key`. */
export type Seen = Map<string, { updated: string; at: number }>

/**
 * The ids of a poll's planned units that are due at `now`: none of its items held by a run, and
 * one of them new or changed since its last attempt and since a run took it (`seen`) within the
 * hour: a unit that run didn't attempt, out of quota or stopped, is due again an hour on.
 */
export function dueUnits(
  plan: RunPlan,
  attempts: Attempts,
  seen: Seen,
  held: Map<string, string>,
  now: number,
): string[] {
  const taken = (i: Item) => {
    const s = seen.get(itemKey(i))
    return s?.updated === updatedOf(i) && now - s.at < HOUR
  }
  const fresh = (i: Item) => attempts[itemKey(i)]?.updated !== updatedOf(i) && !taken(i)
  return plan.units
    .filter((p) => !p.chain && !p.unit.items.some((i) => held.has(itemKey(i))))
    .filter((p) => p.unit.items.some(fresh))
    .map((p) => p.unit.id)
}

/**
 * Takes the plan's units for run `runId` at `now`: their items go in `held` (`source:key` to run id)
 * and `seen`. A unit with an item another run holds is skipped as running
 * there, with its chain.
 */
export function claimUnits(
  plan: RunPlan,
  runId: string,
  held: Map<string, string>,
  seen: Seen,
  now = Date.now(),
): RunPlan {
  const skipped: Skipped[] = [...plan.skipped]
  const busy = new Set<string>()
  for (const p of plan.units.filter((p) => !p.chain)) {
    const other = p.unit.items.map((i) => held.get(itemKey(i))).find((r) => r && r !== runId)
    if (other) {
      busy.add(p.unit.id)
      skipped.push(
        ...p.unit.items.map((item) => ({
          item,
          kind: 'running' as const,
          reason: `running in run ${other}`,
        })),
      )
      continue
    }
    for (const i of p.unit.items) {
      held.set(itemKey(i), runId)
      seen.set(itemKey(i), { updated: updatedOf(i), at: now })
    }
  }
  const units = plan.units.filter((p) => !busy.has(p.chain ?? p.unit.id))
  return { ...plan, units, skipped }
}

/** Lets go of what run `runId` holds. */
export function releaseUnits(held: Map<string, string>, runId: string): void {
  for (const [key, run] of held) if (run === runId) held.delete(key)
}
