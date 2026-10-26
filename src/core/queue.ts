import { planThread } from './plan.js'
import type {
  Age,
  Comparison,
  Item,
  Loop,
  Match,
  Order,
  Rule,
  Scalar,
  ThenStep,
  Where,
  WhereValue,
} from './types.js'

const rule = (skill: string, source: string, where: Where): Rule => ({
  skill,
  source,
  where,
  provider: [],
  skills: [],
  instructions: [],
})

/** The prototype's order; rules for unconfigured sources are dropped. */
export const defaultQueue: Rule[] = [
  rule('fix', 'github', { type: 'pr', mine: true, checks: 'failing' }),
  rule('fix', 'asana', { section: 'QA' }),
  rule('fix', 'linear', { status: 'QA' }),
  rule('fix', 'jira', { status: 'QA' }),
  rule('fix', 'github', { type: 'pr', mine: true, unresolved_threads: { not: 0 } }),
  rule('fix', 'github', {
    type: 'pr',
    mine: true,
    ours: true,
    my_unresolved_threads: { not: 0 },
  }),
  rule('review', 'github', { type: 'pr', review_requested: true, trusted: true }),
  rule('implement', 'asana', { section: 'In progress' }),
  rule('implement', 'linear', { status: 'In Progress' }),
  rule('implement', 'jira', { status: 'In Progress' }),
  rule('plan', 'asana', { section: 'Current sprint' }),
  rule('plan', 'linear', { status: 'Todo' }),
  rule('plan', 'jira', { status: 'To Do' }),
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
    const index = ruleFor(queue, item)
    if (index === -1) unmatched.push(item)
    else ranked.push({ item, rule: index })
  }
  ranked.sort((a, b) => a.rule - b.rule || byOrder(queue[a.rule]?.order)(a.item, b.item))
  return { ranked, unmatched }
}

/** Compares items for a rule's `order`; items without the timestamp go last, in input order. */
function byOrder(order: Order | undefined): (a: Item, b: Item) => number {
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
  return eligible(rule, item) && failedIn(rule.where, item).length === 0
}

/**
 * The index of the rule that takes the item, -1 for none: the first it matches. A task's is the
 * first `planned` rule for its skill, if it matches. An open card of yours carrying awaywork's plan
 * sticks to the `deliver: plan` rule it matches, else the first one for its source whatever its
 * `where` says now, so a move of the card doesn't strand its tasks nor hand it whole to another rule.
 */
export function ruleFor(queue: Rule[], item: Item): number {
  if (item.task) {
    const index = queue.findIndex((r) => eligible(r, item))
    return index >= 0 && matches(queue[index] as Rule, item) ? index : -1
  }
  const planned = item.mine && itemState(item) === 'open' && planThread(item)
  const plans = planned
    ? queue.flatMap((r, i) => (r.deliver === 'plan' && eligible(r, item) ? [i] : []))
    : []
  const plan = plans.find((i) => matches(queue[i] as Rule, item)) ?? plans[0]
  return plan ?? queue.findIndex((r) => matches(r, item))
}

/** An awaywork PR waits for review unless a rule names `ours`; a plan's task goes only to a rule naming `planned` with its skill, and only a task does. */
function eligible(rule: Rule, item: Item): boolean {
  if (rule.source && rule.source !== item.source) return false
  if (item.task || 'planned' in rule.where)
    return !!item.task && 'planned' in rule.where && rule.skill === item.task.skill
  return !isAwayworkPr(item) || 'ours' in rule.where
}

/** An open PR awaywork opened; only the GitHub source can tell, whatever a custom source's `ours` says. */
export function isAwayworkPr(item: Item): boolean {
  return item.source === 'github' && item.fields.ours === true && itemState(item) === 'open'
}

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

/** Among rules the item is eligible for, the one it misses by the fewest keys; the earlier on a tie. */
export function closestRule(
  item: Item,
  queue: Rule[],
): { rule: number; failed: string[] } | undefined {
  let best: { rule: number; failed: string[] } | undefined
  queue.forEach((r, i) => {
    if (!eligible(r, item)) return
    const failed = failedIn(r.where, item)
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

const ages: Record<keyof Age, { words: string; holds: (age: number, span: number) => boolean }> = {
  older_than: { words: 'older than', holds: (age, span) => age > span },
  newer_than: { words: 'newer than', holds: (age, span) => age < span },
}

export const spanPattern = /^\d+[mhdw]$/
const spanUnits: Record<string, number> = { m: 60_000, h: 3_600_000, d: 86_400_000, w: 604_800_000 }

/** Milliseconds in a span like `3d`. */
function spanMs(span: string): number {
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

export function isLoop(entry: ThenStep | Loop): entry is Loop {
  return 'loop' in entry
}

/** The rule and every step it chains, loop steps included, with the config path of each. */
export function ruleSteps(rule: Rule): { step: ThenStep; at: (string | number)[] }[] {
  return [
    { step: rule, at: [] },
    ...(rule.then ?? []).flatMap((entry, j) =>
      isLoop(entry)
        ? entry.loop.map((step, k) => ({ step, at: ['then', j, 'loop', k] }))
        : [{ step: entry, at: ['then', j] }],
    ),
  ]
}

interface RuleMatches {
  taken: Item[]
  /** Items this rule matches that another rule took, with that rule's index: an earlier one, or a plan rule holding its card. */
  shadowed: { item: Item; by: number }[]
}

/** What each rule takes in this run, and what other rules take from it. */
export function ruleMatches(items: Item[], queue: Rule[]): RuleMatches[] {
  const result: RuleMatches[] = queue.map(() => ({ taken: [], shadowed: [] }))
  for (const item of items) {
    const first = ruleFor(queue, item)
    if (first < 0) continue
    result[first]?.taken.push(item)
    queue.forEach((r, i) => {
      if (i !== first && matches(r, item)) result[i]?.shadowed.push({ item, by: first })
    })
  }
  result.forEach((m, i) => {
    m.taken.sort(byOrder(queue[i]?.order))
  })
  return result
}
