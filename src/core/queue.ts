import type { Age, Comparison, Item, Order, Rule, Scalar, WhereValue } from './types.js'

const rule = (skill: string, source: string, where: Rule['where']): Rule => ({
  skill,
  source,
  where,
  provider: [],
  skills: [],
  instructions: [],
})

/** The prototype's order; rules for unconfigured sources are dropped. */
export const defaultQueue: Rule[] = [
  rule('fix-ci', 'github', { type: 'pr', mine: true, checks: 'failing' }),
  rule('qa-feedback', 'asana', { section: 'QA' }),
  rule('qa-feedback', 'linear', { state: 'QA' }),
  rule('address-review', 'github', { type: 'pr', mine: true, unresolved_threads: { not: 0 } }),
  rule('review', 'github', { type: 'pr', review_requested: true, trusted: true }),
  rule('continue', 'asana', { section: 'In progress' }),
  rule('continue', 'linear', { state: 'In Progress' }),
  rule('plan', 'asana', { section: 'Current sprint' }),
  rule('plan', 'linear', { state: 'Todo' }),
]

export function defaultRules(sourceIds: string[]): Rule[] {
  return defaultQueue.filter((r) => r.source && sourceIds.includes(r.source))
}

export interface Ranked {
  item: Item
  rule: number
}

/** Each item takes the first rule it matches; the result is ordered by rule, then the rule's order. */
export function rank(items: Item[], queue: Rule[]): { ranked: Ranked[]; unmatched: Item[] } {
  const ranked: Ranked[] = []
  const unmatched: Item[] = []
  for (const item of items) {
    const index = queue.findIndex((r) => matches(r, item))
    if (index === -1) unmatched.push(item)
    else ranked.push({ item, rule: index })
  }
  ranked.sort((a, b) => a.rule - b.rule || byOrder(queue[a.rule]?.order)(a.item, b.item))
  return { ranked, unmatched }
}

/** Compares items for a rule's `order`; items without the timestamp go last, in input order. */
export function byOrder(order: Order | undefined): (a: Item, b: Item) => number {
  if (!order) return () => 0
  const field = order === 'updated' ? 'updated' : 'created'
  const sign = order === 'oldest' ? 1 : -1
  const time = (item: Item) => Date.parse(String(item.fields[field]))
  return (a, b) => {
    const [x, y] = [time(a), time(b)]
    if (Number.isNaN(x) || Number.isNaN(y)) return Number(Number.isNaN(x)) - Number(Number.isNaN(y))
    return sign * (x - y)
  }
}

export function matches(rule: Rule, item: Item): boolean {
  if (rule.source && rule.source !== item.source) return false
  return failedKeys(rule, item).length === 0
}

/** The `where` keys the item fails; the rule's source is not checked. */
export function failedKeys(rule: Rule, item: Item): string[] {
  return Object.keys(rule.where).filter(
    (key) => !matchesValue(rule.where[key] as WhereValue, fieldValue(item, key)),
  )
}

export function fieldValue(item: Item, key: string): unknown {
  return key === 'type' ? item.type : item.fields[key]
}

/** Among rules for the item's source, the one it misses by the fewest keys; the earlier on a tie. */
export function closestRule(
  item: Item,
  queue: Rule[],
): { rule: number; failed: string[] } | undefined {
  let best: { rule: number; failed: string[] } | undefined
  queue.forEach((r, i) => {
    if (r.source && r.source !== item.source) return
    const failed = failedKeys(r, item)
    if (!best || failed.length < best.failed.length) best = { rule: i, failed }
  })
  return best
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

export const ages: Record<
  keyof Age,
  { words: string; holds: (age: number, span: number) => boolean }
> = {
  older_than: { words: 'older than', holds: (age, span) => age > span },
  newer_than: { words: 'newer than', holds: (age, span) => age < span },
}

export const spanPattern = /^\d+[mhdw]$/
const spanUnits: Record<string, number> = { m: 60_000, h: 3_600_000, d: 86_400_000, w: 604_800_000 }

/** Milliseconds in a span like `3d`. */
export function spanMs(span: string): number {
  return Number(span.slice(0, -1)) * (spanUnits[span.slice(-1)] ?? Number.NaN)
}

export function isAge(want: object): want is Age {
  return 'older_than' in want || 'newer_than' in want
}

export function spans(want: Age): [keyof Age, string][] {
  return Object.entries(want) as [keyof Age, string][]
}

/** E.g. `>= 2 and < 5`, or `older than 3d`. */
export function describeComparison(want: Comparison | Age): string {
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

function matchesValue(want: WhereValue, actual: unknown): boolean {
  const values = Array.isArray(actual) ? actual : [actual]
  if (typeof want === 'object' && !Array.isArray(want)) {
    if ('not' in want) return !matchesValue(want.not, actual)
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
  return values.some((v) => wanted.includes(v))
}

export interface RuleMatches {
  taken: Item[]
  /** Items this rule matches that an earlier rule took, with that rule's index. */
  shadowed: { item: Item; by: number }[]
}

/** What each rule takes tonight, and what earlier rules take from it. */
export function ruleMatches(items: Item[], queue: Rule[]): RuleMatches[] {
  const result: RuleMatches[] = queue.map(() => ({ taken: [], shadowed: [] }))
  for (const item of items) {
    const [first, ...rest] = queue.flatMap((r, i) => (matches(r, item) ? [i] : []))
    if (first === undefined) continue
    result[first]?.taken.push(item)
    for (const i of rest) result[i]?.shadowed.push({ item, by: first })
  }
  result.forEach((m, i) => {
    m.taken.sort(byOrder(queue[i]?.order))
  })
  return result
}
