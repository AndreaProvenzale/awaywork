import type { Budget } from '../config/schema.js'
import type { Quota } from './types.js'

export const MAX_TURNS = 200
const DAY = 24 * 60 * 60 * 1000

export type Allowance =
  | {
      kind: 'quota'
      window: string
      used: number
      ceiling: number
      nights: number
      limits: { name: 'per_night' | 'reserve' | 'pacing'; value: number }[]
      session?: { used: number; stopAt: number }
    }
  | { kind: 'fallback'; units: number; turns: number; reason: string }

/** Tonight's ceiling on the long window: the lowest of used + per_night, 1 - reserve and the paced share. */
export function allowance(
  budget: Budget,
  quota: Quota | null,
  now: number,
  reason = 'no quota reading',
): Allowance {
  const long = quota?.windows.find((w) => w.span === 'long')
  if (!long) return { kind: 'fallback', ...budget.fallback, reason }
  const nights = Math.max(1, Math.ceil((long.resetsAt * 1000 - now) / DAY))
  const limits: Extract<Allowance, { kind: 'quota' }>['limits'] = [
    { name: 'reserve', value: 1 - budget.reserve },
    { name: 'pacing', value: long.used + (1 - budget.reserve - long.used) / nights },
  ]
  if (budget.per_night !== undefined)
    limits.unshift({ name: 'per_night', value: long.used + budget.per_night })
  const short = quota?.windows.find((w) => w.span === 'short')
  return {
    kind: 'quota',
    window: long.name,
    used: long.used,
    ceiling: Math.min(...limits.map((l) => l.value)),
    nights,
    limits,
    session: short && { used: short.used, stopAt: budget.session_max },
  }
}

/** The first candidate still under its ceiling, or under its fallback unit cap given units already routed. */
export function route(
  candidates: string[],
  allowances: Record<string, Allowance>,
  routed: Record<string, number>,
): { provider?: string; passed: string[] } {
  const passed: string[] = []
  for (const id of candidates) {
    const a = allowances[id]
    if (!a) continue
    if (a.kind === 'quota' && a.session && a.session.used >= a.session.stopAt) {
      passed.push(`${id} at session_max (${pct(a.session.used)} of ${pct(a.session.stopAt)})`)
      continue
    }
    if (a.kind === 'quota' && a.used < a.ceiling) return { provider: id, passed }
    if (a.kind === 'fallback' && (routed[id] ?? 0) < a.units) return { provider: id, passed }
    passed.push(
      a.kind === 'quota'
        ? `${id} at its ceiling (${pct(a.used)} of ${pct(a.ceiling)})`
        : `${id} used its ${a.units} fallback units`,
    )
  }
  return { passed }
}

export const pct = (share: number) => `${Math.round(share * 1000) / 10}%`

/** What a quota condition reads: nights to the reset and the share left under the ceiling; none without a reading. */
export function quotaFacts(a: Allowance): { nights?: number; headroom?: number } {
  return a.kind === 'quota'
    ? { nights: a.nights, headroom: Math.max(0, Math.round((a.ceiling - a.used) * 1000) / 1000) }
    : {}
}

/** The same ceiling with usage moved to what a worker last saw. */
export function withQuota(a: Allowance, quota: Quota): Allowance {
  if (a.kind !== 'quota') return a
  const long = quota.windows.find((w) => w.name === a.window)
  const short = quota.windows.find((w) => w.span === 'short')
  const session = a.session && short ? { ...a.session, used: short.used } : a.session
  return { ...a, used: long?.used ?? a.used, session }
}
