import type { Budget } from '#config/schema'
import type { Quota } from '#core/types'
import { counted } from '#util/text'
import { nextOpening, runsLeft, type Window } from './window'

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
      /** Each model's own windows as a worker last read them, by the model it ran: `default` for the binary's. */
      models?: Record<string, Quota['windows']>
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
 * A present run, one started outside every window, reads pacing at its start, stops workers at `present_session_max` and skips providers without a quota reading.
 * An away run reads pacing at the opening after its window, or the reset, whichever comes first: nobody else spends what accrues before then.
 */
export function allowance(
  budget: Budget,
  quota: Quota | null,
  now: number,
  windows: Window[],
  { present = false, reason = 'no quota reading' }: { present?: boolean; reason?: string } = {},
): Allowance {
  const long = quota?.windows.find((w) => w.span === 'long' && !w.scoped)
  if (!long)
    return { kind: 'fallback', ...budget.fallback, reason, ...(present && { present: true }) }
  const length = (long.minutes ?? WEEK_MINUTES) * 60_000
  const reset = long.resetsAt * 1000
  const readAt = present ? now : (nextOpening(windows, now, reset) ?? reset)
  const elapsed = readAt - (reset - length)
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
    runs: runsLeft(windows, now, reset),
    limits,
    session: short && {
      used: short.used,
      stopAt: present ? budget.present_session_max : budget.session_max,
      limit: present ? 'present_session_max' : 'session_max',
    },
  }
}

const clamp = (n: number, min: number, max: number) => Math.min(max, Math.max(min, n))

/** This run's ceiling on a model's own window: the long window's but for `per_run`, which the long window already holds the model's spend to. */
export const modelCeiling = (a: Extract<Allowance, { kind: 'quota' }>) =>
  Math.min(...a.limits.filter((l) => l.name !== 'per_run').map((l) => l.value))

/** The first model-scoped window in `windows` at this run's ceiling on it, as a stop reason. */
export function scopedOver(a: Allowance, windows: Quota['windows']): string | undefined {
  if (a.kind !== 'quota') return
  const ceiling = modelCeiling(a)
  const over = windows.find((w) => w.scoped && w.used >= ceiling)
  return over && `${over.name} at ${pct(over.used)}, ceiling ${pct(ceiling)}`
}

/** Why `model`, unset for the binary's default, has no room left by its windows' last reading. */
export const modelOver = (a: Allowance, model?: string) =>
  a.kind === 'quota' ? scopedOver(a, a.models?.[model ?? 'default'] ?? []) : undefined

/**
 * The first candidate still under its ceiling, or under its fallback unit cap given units already routed,
 * and the first of its `models`, the ones the unit tries on it in turn, with room left.
 */
export function route(
  candidates: string[],
  allowances: Record<string, Allowance>,
  routed: Record<string, number>,
  models?: (id: string) => (string | undefined)[],
): { provider?: string; model?: number; passed: string[] } {
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
      passed.push(`${id} sits out a present run (${a.reason})`)
      continue
    }
    if (a.kind === 'quota' && a.used < a.ceiling) {
      const tries = models?.(id)
      const model = tries?.findIndex((m) => !modelOver(a, m))
      if (model === undefined) return { provider: id, passed }
      if (model >= 0) return { provider: id, model, passed }
      for (const m of tries ?? [])
        passed.push(`${id} on ${m ?? 'its default model'} at its ceiling (${modelOver(a, m)})`)
      continue
    }
    if (a.kind === 'fallback' && (routed[id] ?? 0) < a.units) return { provider: id, passed }
    passed.push(
      a.kind === 'quota'
        ? `${id} at its ceiling (${pct(a.used)} of ${pct(a.ceiling)})`
        : `${id} used its ${counted(a.units, 'fallback unit')}`,
    )
  }
  return { passed }
}

/** Names the session limit a run got: away inside a window, present outside every window. */
export const presenceLine = (present: boolean) =>
  present
    ? 'present run (outside the windows): present_session_max'
    : 'away run (inside a window): session_max'

export const pct = (share: number) => `${Math.round(share * 1000) / 10}%`

/** What a quota condition reads: runs to the reset and the share left under the ceiling; none without a reading. */
export function quotaFacts(a: Allowance): { runs?: number; headroom?: number } {
  return a.kind === 'quota'
    ? { runs: a.runs, headroom: Math.max(0, Math.round((a.ceiling - a.used) * 1000) / 1000) }
    : {}
}

/** The same ceiling with usage moved to what a worker on `model`, unset for the binary's default, last saw. */
export function withQuota(a: Allowance, quota: Quota, model?: string): Allowance {
  if (a.kind !== 'quota') return a
  const long = quota.windows.find((w) => w.name === a.window)
  const short = quota.windows.find((w) => w.span === 'short')
  const session = a.session && short ? { ...a.session, used: short.used } : a.session
  const scoped = quota.windows.filter((w) => w.scoped)
  const models = scoped.length ? { ...a.models, [model ?? 'default']: scoped } : a.models
  return {
    ...a,
    used: long?.used ?? a.used,
    resetsAt: long?.resetsAt ?? a.resetsAt,
    session,
    ...(models && { models }),
  }
}
