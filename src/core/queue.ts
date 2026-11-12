import { planThread } from './plan.js'
import { type Post, postAnswer, reportPost } from './posts.js'
import type { Item, Loop, Order, Rule, ThenStep, Where } from './types.js'
import { failedIn, itemState } from './where.js'

const rule = (skill: string, source: string, where: Where): Rule => ({
  skill,
  source,
  where,
  provider: [],
  skills: [],
  instructions: [],
})

/** `init`'s template, in the prototype's order; rules for unconfigured sources are dropped. */
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
 * A report rule whose result on the item you approved is done with it: the next rule takes it.
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
  return plan ?? queue.findIndex((r) => matches(r, item) && !doneWith(r, item))
}

/** Whether the rule's newest post on the item, a plan or a result, waits for your answer: it holds the item for that rule only. A file of it edited in the store is feedback. */
export function waitsOn(rule: Rule, item: Item): boolean {
  const thread = rule.deliver === 'plan' ? planThread(item) : undefined
  const post = thread
    ? { post: thread.plan, answer: thread.answer }
    : rule.deliver === 'report'
      ? reportPost(item, rule.skill)
      : undefined
  return !!post && !post.answer && !post.post.pinned?.stale
}

/** A report rule's newest result on the item, once you approved it or it went ahead: the rule doesn't run on it again. */
export function doneWith(rule: Rule, item: Item): Post | undefined {
  const post = rule.deliver === 'report' ? reportPost(item, rule.skill) : undefined
  return post && postAnswer(post) === 'approved' ? post : undefined
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

/** The thread host a rule posts on, `github` or a custom source; unset when it posts on the item. */
export const ruleThread = (rule: Pick<Rule, 'thread'>): string | undefined =>
  rule.thread === 'item' ? undefined : rule.thread

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
