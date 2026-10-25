import type { Budget } from '../config/schema.js'
import type { Quota } from './types.js'
import { runsLeft, type Window } from './window.js'

export const MAX_TURNS = 200

export type Allowance =
  | {
      kind: 'quota'
      window: string
      used: number
      /** When the long window resets, in unix seconds. */
      resetsAt: number
      ceiling: number
      runs: number
      limits: { name: 'per_run' | 'reserve' | 'pacing'; value: number }[]
      session?: { used: number; stopAt: number; limit: SessionLimit }
    }
  | {
      kind: 'fallback'
      units: number
      turns: number
      reason: string
      /** A present run routes around a provider it can't read. */
      present?: true
    }

export type SessionLimit = 'session_max' | 'present_session_max'

/** A long window without a length counts as a week. */
const WEEK_MINUTES = 7 * 24 * 60

/**
 * This run's ceiling on the long window: the lowest of used + per_run, 1 - reserve and pacing, an even spend from 0 at the window's start to 1 - reserve at its reset.
 * A present run, one started outside every window, stops workers at `present_session_max` and skips providers without a quota reading.
 */
export function allowance(
  budget: Budget,
  quota: Quota | null,
  now: number,
  windows: Window[],
  { present = false, reason = 'no quota reading' }: { present?: boolean; reason?: string } = {},
): Allowance {
  const long = quota?.windows.find((w) => w.span === 'long')
  if (!long)
    return { kind: 'fallback', ...budget.fallback, reason, ...(present && { present: true }) }
  const length = (long.minutes ?? WEEK_MINUTES) * 60_000
  const elapsed = now - (long.resetsAt * 1000 - length)
  const limits: Extract<Allowance, { kind: 'quota' }>['limits'] = [
    { name: 'reserve', value: 1 - budget.reserve },
    {
      name: 'pacing',
      value: clamp((1 - budget.reserve) * (elapsed / length), 0, 1 - budget.reserve),
    },
  ]
  if (budget.per_run !== undefined)
    limits.unshift({ name: 'per_run', value: long.used + budget.per_run })
  const short = quota?.windows.find((w) => w.span === 'short')
  return {
    kind: 'quota',
    window: long.name,
    used: long.used,
    resetsAt: long.resetsAt,
    ceiling: Math.min(...limits.map((l) => l.value)),
    runs: runsLeft(windows, now, long.resetsAt * 1000),
    limits,
    session: short && {
      used: short.used,
      stopAt: present ? budget.present_session_max : budget.session_max,
      limit: present ? 'present_session_max' : 'session_max',
    },
  }
}

const clamp = (n: number, min: number, max: number) => Math.min(max, Math.max(min, n))

/** The first candidate still under its ceiling, or under its fallback unit cap given units already routed. */
export function route(
  candidates: string[],
  allowances: Record<string, Allowance>,
  routed: Record<string, number>,
): { provider?: string; passed: string[] } {
  const passed: string[] = []
  for (const id of candidates) {
    const a = allowances[id]
    if (!a) {
      passed.push(`${id} unavailable`)
      continue
    }
    if (a.kind === 'quota' && a.session && a.session.used >= a.session.stopAt) {
      passed.push(
        `${id} at ${a.session.limit} (${pct(a.session.used)} of ${pct(a.session.stopAt)})`,
      )
      continue
    }
    if (a.kind === 'fallback' && a.present) {
      passed.push(`${id} has no quota reading, which a present run needs`)
      continue
    }
    if (a.kind === 'quota' && a.used < a.ceiling) return { provider: id, passed }
    if (a.kind === 'fallback' && (routed[id] ?? 0) < a.units) return { provider: id, passed }
    passed.push(
      a.kind === 'quota'
        ? `${id} at its ceiling (${pct(a.used)} of ${pct(a.ceiling)})`
        : `${id} used its ${a.units} fallback unit${a.units === 1 ? '' : 's'}`,
    )
  }
  return { passed }
}

/** Names the session limit a run got: away inside a window, present outside every window. */
export const presenceLine = (present: boolean) =>
  present
    ? 'present run (outside the windows): workers stop at present_session_max; providers without a quota reading sit out'
    : 'away run (inside a window): workers stop at session_max'

export const pct = (share: number) => `${Math.round(share * 1000) / 10}%`

/** What a quota condition reads: runs to the reset and the share left under the ceiling; none without a reading. */
export function quotaFacts(a: Allowance): { runs?: number; headroom?: number } {
  return a.kind === 'quota'
    ? { runs: a.runs, headroom: Math.max(0, Math.round((a.ceiling - a.used) * 1000) / 1000) }
    : {}
}

/** The same ceiling with usage moved to what a worker last saw. */
export function withQuota(a: Allowance, quota: Quota): Allowance {
  if (a.kind !== 'quota') return a
  const long = quota.windows.find((w) => w.name === a.window)
  const short = quota.windows.find((w) => w.span === 'short')
  const session = a.session && short ? { ...a.session, used: short.used } : a.session
  return { ...a, used: long?.used ?? a.used, resetsAt: long?.resetsAt ?? a.resetsAt, session }
}
