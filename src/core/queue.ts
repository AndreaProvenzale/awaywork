import type { Item, Rule, Scalar, WhereValue } from './types.js'

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
  rule('review', 'github', { type: 'pr', review_requested: true }),
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

/** Each item takes the first rule it matches; the result is ordered by rule, then input order. */
export function rank(items: Item[], queue: Rule[]): { ranked: Ranked[]; unmatched: Item[] } {
  const ranked: Ranked[] = []
  const unmatched: Item[] = []
  for (const item of items) {
    const index = queue.findIndex((r) => matches(r, item))
    if (index === -1) unmatched.push(item)
    else ranked.push({ item, rule: index })
  }
  return { ranked: ranked.sort((a, b) => a.rule - b.rule), unmatched }
}

export function matches(rule: Rule, item: Item): boolean {
  if (rule.source && rule.source !== item.source) return false
  return Object.entries(rule.where).every(([key, want]) =>
    matchesValue(want, key === 'type' ? item.type : item.fields[key]),
  )
}

function matchesValue(want: WhereValue, actual: unknown): boolean {
  if (typeof want === 'object' && !Array.isArray(want)) return !matchesValue(want.not, actual)
  const wanted: Scalar[] = [want].flat()
  const values = Array.isArray(actual) ? actual : [actual]
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
  return result
}
