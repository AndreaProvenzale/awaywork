import type { Age, Comparison, Item, Match, Scalar, Where, WhereValue } from './types.js'

export const itemStates = ['open', 'merged', 'closed'] as const
export type ItemState = (typeof itemStates)[number]

/** Whether the item is open, or a PR merged, or closed unmerged, done or canceled; open unless its source says. */
export function itemState(item: Item): ItemState {
  const state = item.fields.state
  return state === 'merged' || state === 'closed' ? state : 'open'
}

/** How far back a rule reads finished items when its `where` doesn't bound `closed`. */
export const DEFAULT_LOOKBACK = '7d'

/** What a finished item is held to where no level of a `where` says: open items only, read back {@link DEFAULT_LOOKBACK}. */
export const implicitWhere: Where = { state: 'open', closed: { newer_than: DEFAULT_LOOKBACK } }

/** Whether a level of a `where`, or one around it, names `state`, and the tightest `closed: { newer_than }` among them. */
export type Scope = { named: boolean; bound: number }

export const TOP: Scope = { named: false, bound: Number.POSITIVE_INFINITY }

export function within(where: Where, outer: Scope): Scope {
  const newer = newerThan(where.closed as WhereValue | undefined)
  return {
    named: outer.named || 'state' in where,
    bound: Math.min(outer.bound, newer ? spanMs(newer) : Number.POSITIVE_INFINITY),
  }
}

export function newerThan(value: WhereValue | undefined): string | undefined {
  return typeof value === 'object' && !Array.isArray(value) && isAge(value)
    ? value.newer_than
    : undefined
}

/**
 * How far back, in milliseconds, a `where` reads finished (merged or closed) items: the widest
 * `closed: { newer_than }` among the ways through its `any` that can match one, {@link DEFAULT_LOOKBACK}
 * where one sets none. Undefined when it matches open items only: a way through that never names
 * `state` does.
 */
export function lookback(where: Where, outer = TOP): number | undefined {
  const state = where.state as WhereValue | undefined
  if (state !== undefined && !['merged', 'closed'].some((s) => matchesValue(state, s)))
    return undefined
  const scope = within(where, outer)
  const any = where.any as Where[] | undefined
  if (any) {
    const reached = any.flatMap((w) => lookback(w, scope) ?? [])
    return reached.length > 0 ? Math.max(...reached) : undefined
  }
  if (!scope.named) return undefined
  return Number.isFinite(scope.bound) ? scope.bound : spanMs(DEFAULT_LOOKBACK)
}

/** Whether some way through `where` can match an open item, which has no `closed`. */
export function matchesOpen(where: Where): boolean {
  if (where.state !== undefined && !matchesValue(where.state as WhereValue, 'open')) return false
  if (where.closed !== undefined && !matchesValue(where.closed as WhereValue, undefined))
    return false
  return !where.any || (where.any as Where[]).some(matchesOpen)
}

/**
 * The keys of `where` the item fails; `any` fails when every entry fails. A finished item also
 * fails `state` on a way through that never names it, and `closed` past {@link DEFAULT_LOOKBACK}
 * on one that never bounds it.
 */
export function failedIn(where: Where, item: Item, outer = TOP): string[] {
  const scope = within(where, outer)
  const failed = Object.keys(where).filter((key) =>
    key === 'any'
      ? !(where[key] as Where[]).some((w) => failedIn(w, item, scope).length === 0)
      : !matchesValue(where[key] as WhereValue, fieldValue(item, key)),
  )
  if ('any' in where || itemState(item) === 'open') return failed
  if (!scope.named) return [...failed, 'state']
  // One without a `closed` time can't be too old.
  const tooOld = Date.now() - timestamp(item.fields.closed) > spanMs(DEFAULT_LOOKBACK)
  return Number.isFinite(scope.bound) || !tooOld || failed.includes('closed')
    ? failed
    : [...failed, 'closed']
}

export function fieldValue(item: Item, key: string): unknown {
  if (key === 'type' || key === 'title' || key === 'description') return item[key]
  if (key === 'planned') return !!item.task
  return item.fields[key]
}

export const comparisons: Record<
  keyof Comparison,
  { symbol: string; holds: (value: number, bound: number) => boolean }
> = {
  gt: { symbol: '>', holds: (v, bound) => v > bound },
  gte: { symbol: '>=', holds: (v, bound) => v >= bound },
  lt: { symbol: '<', holds: (v, bound) => v < bound },
  lte: { symbol: '<=', holds: (v, bound) => v <= bound },
}

export function bounds(want: Comparison): [keyof Comparison, number][] {
  return Object.entries(want) as [keyof Comparison, number][]
}

const ages: Record<keyof Age, { words: string; holds: (age: number, span: number) => boolean }> = {
  older_than: { words: 'older than', holds: (age, span) => age > span },
  newer_than: { words: 'newer than', holds: (age, span) => age < span },
}

export const spanPattern = /^\d+[mhdw]$/
const spanUnits: Record<string, number> = { m: 60_000, h: 3_600_000, d: 86_400_000, w: 604_800_000 }

/** Milliseconds in a span like `3d`. */
export function spanMs(span: string): number {
  return Number(span.slice(0, -1)) * (spanUnits[span.slice(-1)] ?? Number.NaN)
}

export function isMatch(want: object): want is Match {
  return 'matches' in want
}

export function isAge(want: object): want is Age {
  return 'older_than' in want || 'newer_than' in want
}

export function spans(want: Age): [keyof Age, string][] {
  return Object.entries(want) as [keyof Age, string][]
}

/** E.g. `>= 2 and < 5`, `older than 3d`, or `matches /bug/i`. */
export function describeComparison(want: Comparison | Age | Match): string {
  if (isMatch(want)) return `matches /${want.matches}/i`
  const parts = isAge(want)
    ? spans(want).map(([op, span]) => `${ages[op].words} ${span}`)
    : bounds(want).map(([op, bound]) => `${comparisons[op].symbol} ${bound}`)
  return parts.join(' and ')
}

/** Epoch milliseconds of an ISO date or datetime; NaN for anything else. */
function timestamp(value: unknown): number {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}/.test(value)
    ? Date.parse(value)
    : Number.NaN
}

export function matchesValue(want: WhereValue, actual: unknown): boolean {
  const values = Array.isArray(actual) ? actual : [actual]
  if (typeof want === 'object' && !Array.isArray(want)) {
    if ('not' in want) return !matchesValue(want.not, actual)
    if (isMatch(want)) {
      const pattern = new RegExp(want.matches, 'i')
      return values.some((v) => typeof v === 'string' && pattern.test(v))
    }
    if (isAge(want)) {
      const now = Date.now()
      return values.some((v) => {
        const age = now - timestamp(v)
        return spans(want).every(([op, span]) => ages[op].holds(age, spanMs(span)))
      })
    }
    return values.some(
      (v) => typeof v === 'number' && bounds(want).every(([op, b]) => comparisons[op].holds(v, b)),
    )
  }
  const wanted: Scalar[] = [want].flat()
  return values.some((v) => wanted.some((w) => equals(w, v)))
}

/** Strings compare ignoring case, so `In progress` matches a state called `In Progress`. */
function equals(want: Scalar, actual: unknown): boolean {
  return typeof want === 'string' && typeof actual === 'string'
    ? want.toLowerCase() === actual.toLowerCase()
    : want === actual
}
