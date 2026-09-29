import type { Comparison, Item, Order, Rule, Scalar, WhereValue } from './types.js'

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
  rule('address-review', 'github', { type: 'pr', mine: true, unresolved_threads: { not: 0 } }),
  rule('review', 'github', { type: 'pr', review_requested: true, trusted: true }),
  rule('continue', 'asana', { section: 'In progress' }),
  rule('plan', 'asana', { section: 'Current sprint' }),
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

/** E.g. `>= 2 and < 5`. */
export function describeComparison(want: Comparison): string {
  return bounds(want)
    .map(([op, bound]) => `${comparisons[op].symbol} ${bound}`)
    .join(' and ')
}

function matchesValue(want: WhereValue, actual: unknown): boolean {
  const values = Array.isArray(actual) ? actual : [actual]
  if (typeof want === 'object' && !Array.isArray(want)) {
    if ('not' in want) return !matchesValue(want.not, actual)
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
