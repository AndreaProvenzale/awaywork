import type { Setup } from '#config/skills'
import type { Origin } from '#core/skills'
import type { Condition, Item, Rule, Step, ThenStep, Unit, Where, WhereValue } from '#core/types'
import { postAnswer, reportPost } from '#posts/posts'
import type { Moved } from '#posts/report'
import type { Allowance } from '#quota/budget'
import { committingStep, expandPlans, planLimits } from '#tasks/fanout'
import { latestResult, planState } from '#tasks/plan-file'
import { globToRegExp } from '#util/glob'
import type { Attempts } from './attempts'
import { chainUnits, landing } from './chain'
import {
  type Group,
  holdsOn,
  landsOnOpen,
  openedElsewhere,
  openUrl,
  postsOn,
  refusal,
  stackTarget,
  waits,
} from './holds'
import {
  closestRule,
  dedupe,
  doneWith,
  isAwayworkPr,
  isLoop,
  matches,
  type Ranked,
  rank,
  ruleFor,
  waitsOn,
} from './queue'
import type { Skip } from './skips'
import {
  describeComparison,
  failedIn,
  fieldValue,
  implicitWhere,
  isMatch,
  TOP,
  within,
} from './where'

export { taskChain } from './holds'

export interface PlannedUnit {
  unit: Unit
  rule: number
  itemRules: number[]
  origin?: Origin
  provider?: string
  passed: string[]
  /** Why its quota `when` fails now: the run checks again as windows fill, and skips it if it still fails. */
  quotaUnmet?: string
  /** Why the run skips it: an author off `trust` steers it and its agent's shell sandbox won't start where it runs. */
  shellRefused?: string
  /** The rule's unit whose chain this step is part of, by id: it works in that unit's clone. */
  chain?: string
  loop?: LoopRound
  /** On a task's first step: the chain, by id, earlier in this run whose PR it stacks on. */
  after?: string
  /** On a task's first step: its `opened` tasks in other repos that open their PR earlier in this run, which it waits for. */
  waitsFor?: string[]
}

export interface LoopRound {
  /** The loop's index in the rule's `then`. */
  at: number
  round: number
  /** The step's index in the loop. */
  step: number
  skills: string[]
  until: Condition
  max: number
}

/** Why an item made no unit. */
export type SkipKind =
  | 'no_rule'
  | 'skipped_by_you'
  | 'unchanged'
  | 'over_cap'
  | 'waiting_for_review'
  | 'waiting_for_answer'
  | 'waiting_for_approval'
  | 'approved'
  | 'invalid_plan'
  | 'store_failed'
  | 'fanned_out'
  | 'waiting_for_task'
  | 'task_merged'
  | 'task_done'
  | 'all_tasks_done'
  | 'gave_up'
  | 'no_repo'
  | 'unlisted_repo'
  | 'invalid_branch'
  | 'refused_delivery'
  | 'draft_moved'
  | 'continue_cap'
  | 'continues_later'
  | 'running'

/** Whether you can act to make the item run: the rest is the config working as intended. */
export const needsYou: Record<SkipKind, boolean> = {
  no_rule: false,
  skipped_by_you: false,
  unchanged: false,
  over_cap: false,
  waiting_for_review: true,
  waiting_for_answer: true,
  waiting_for_approval: true,
  approved: false,
  invalid_plan: true,
  store_failed: true,
  fanned_out: false,
  waiting_for_task: false,
  task_merged: false,
  task_done: false,
  all_tasks_done: true,
  gave_up: true,
  no_repo: true,
  unlisted_repo: false,
  invalid_branch: true,
  refused_delivery: true,
  draft_moved: true,
  continue_cap: true,
  continues_later: false,
  running: false,
}

/** Why an item, or a group of them, made no unit. */
export interface SkipReason {
  kind: SkipKind
  reason: string
  /** The PR it waits on for review: one the item links, the PR awaywork pushed onto, or the item itself; or the item awaywork asked its questions or posted its plan on. */
  url?: string
  /** When the wait began, as an ISO time, when it's known. */
  since?: string
}

/** An item the run made no unit for, and why. */
export interface Skipped extends SkipReason {
  item: Item
}

/** What every group of a run is planned against, built once in `planRun`. */
export interface PlanRun extends Setup {
  allowances: Record<string, Allowance>
  skips: Record<string, Skip>
  attempts: Attempts
  /** The time attempts are judged at. */
  now: number
  /** A `run: soon` run. */
  soon: boolean
}

export interface RunPlan {
  queue: Rule[]
  units: PlannedUnit[]
  skipped: Skipped[]
  allowances: Record<string, Allowance>
  /** Whether the run started outside every window; set once the quota is read. */
  present?: boolean
  /** Each routine's next occurrence, by name, as an ISO time. */
  routines?: Record<string, string>
  /** The moves on_done held on posts you approved since, made before planning. */
  moved?: Moved[]
}

/** Match, dedupe and route this run's items; no I/O. */
export function planRun(input: {
  setup: Setup
  items: Item[]
  allowances: Record<string, Allowance>
  skips?: Record<string, Skip>
  /** Earlier attempts: a unit none of whose items changed since its skill last finished, or failed 3 times within the week, is skipped. */
  attempts?: Attempts
  /** The time attempts are judged at; defaults to now. */
  now?: number
  /** Plans only the units of a repo glob, a 1-based rule, `run: soon` rules and these unit ids, under the full run's caps; neither they nor its skip or attempts hold back the unit `named` names, and with `skill` a one-off rule of that skill takes the item `named` names if no rule does. */
  only?: {
    repo?: string
    rule?: number
    soon?: boolean
    units?: string[]
    named?: string
    skill?: string
  }
}): RunPlan {
  const { setup, allowances, skips = {}, now = Date.now(), only = {} } = input
  const onlyRepo = only.repo === undefined ? undefined : globToRegExp(only.repo)
  const { queue } = setup
  const expanded = expandPlans(setup, input.items, skips)
  const name = only.named
  // A task you name of a card you skipped runs; the card and its other tasks stay skipped.
  const namedTasks =
    name === undefined
      ? []
      : expandPlans(setup, input.items).items.filter((item) => {
          const card = item.task?.parent
          const taking = queue[ruleFor(queue, item)]
          return (
            card &&
            taking &&
            skips[`${card.source}:${card.key}`] &&
            namesChain(slug(item.key), taking, [item], name)
          )
        })
  const candidates = [...expanded.items, ...namedTasks]
  const { ranked, unmatched } = rank(candidates, queue)
  const picked =
    only.skill !== undefined && name !== undefined
      ? unmatched.filter(
          (item) =>
            namesUnit(slug(item.key), [item], name) && noRuleReason(item, queue).kind === 'no_rule',
        )
      : []
  // Last, so a real rule always wins; everything else reads `queue`, which never holds it.
  const rules = only.skill !== undefined ? [...queue, oneOffRule(only.skill)] : queue
  const skipped: Skipped[] = [
    ...expanded.skipped,
    ...unmatched
      .filter((item) => !picked.includes(item))
      .map((item) => ({ item, ...noRuleReason(item, queue) })),
  ]
  const units: PlannedUnit[] = []
  const run: PlanRun = {
    ...setup,
    allowances,
    skips,
    attempts: input.attempts ?? {},
    now,
    soon: !!only.soon,
  }

  // A post that waits holds its card for its rule only: the card's linked items rank on their own.
  const waiting = (e: Ranked) => waitsOn(rules[e.rule] as Rule, e.item)
  const takenHere = [...ranked, ...picked.map((item) => ({ item, rule: queue.length }))]
  const blocks = inBlocks(dedupe(takenHere, waiting), candidates)
  const caps: Caps = {
    routed: {},
    perRepo: {},
    perRule: {},
    counted: 0,
    open: { total: new Set(), perRule: {} },
  }
  const linked = new Set<string>()
  const link = (item: Item) => {
    for (const pr of [...item.linkedPrs, ...Object.values(item.task?.parent.taskPrs ?? {})])
      linked.add(pr.url)
  }
  for (const found of blocks) {
    for (const { item } of found) link(item)
    const group = readGroup(run, rules, found, [], waiting)
    const url = openUrl(group, holdsOn(run, group, []))
    if (url) markOpen(caps, group.ruleIndex, openKey(group.lead, url))
  }
  for (const { item, kind } of expanded.skipped)
    if (item.task && waits.includes(kind) && ruleFor(queue, item) >= 0) {
      link(item)
      markOpen(caps, ruleFor(queue, item), openKey(item, ''))
    }
  for (const { task } of unmatched) {
    const prs = Object.values(task?.parent.taskPrs ?? {}).filter(
      (pr) => pr.state === 'open' && !linked.has(pr.url),
    )
    for (const pr of prs) linked.add(pr.url)
    if (task && prs.length) caps.open.total.add(task.parent.url)
  }
  for (const item of unmatched.filter(isAwayworkPr))
    if (!linked.has(item.url)) caps.open.total.add(item.url)
  for (const found of blocks) {
    const group = readGroup(run, rules, found, units, waiting)
    const { items, lead, rule, ruleIndex, id, ours, draft, prs } = group
    if (only.rule !== undefined && ruleIndex + 1 !== only.rule) continue
    if (only.soon && rule.run !== 'soon') continue
    if (only.units && !only.units.includes(id)) continue
    const skip = ({ kind, reason, url, since }: SkipReason) =>
      skipped.push(
        ...items.map((item) => ({
          item,
          kind,
          reason,
          ...(url && { url }),
          ...(since && { since }),
        })),
      )
    // An approved plan runs as its tasks, so naming its card lifts nothing.
    const named =
      name !== undefined && group.card?.state !== 'approved' && namesChain(id, rule, items, name)
    const held = holdsOn(run, group, units)
    const hold = held.find((h) => !(named && h.liftable))
    if (hold) {
      skip(hold)
      continue
    }
    // A unit you name goes past its holds, taking no room under the caps a run without the name would have left.
    const lifted = held.length > 0 || namedTasks.includes(lead)
    const committing = committingStep(rule, run.catalog)
    const pr = (draft && ours) || (committing ? prs.find((p) => p.mine) : undefined) || prs[0]
    const repo = pr?.repo ?? items.map((i) => i.fields.repo).find((r) => typeof r === 'string')
    if (!repo) {
      skip({ kind: 'no_repo', reason: 'no repo: no linked PR or repo field' })
      continue
    }
    if (onlyRepo && !onlyRepo.test(repo)) continue
    const at = landing(run, group, { repo, pr, committing })
    const refused = refusal(run, group, at)
    if (refused) {
      skip(refused)
      continue
    }
    const key = openKey(lead, openUrl(group, held) ?? id)
    const capped = overCap(caps, run, group, repo, key)
    if (capped && !named) {
      skip({ kind: 'over_cap', reason: capped })
      continue
    }
    const chain = chainUnits(run, group, at, caps.routed)
    units.push(...chain.units)
    if (chain.counts && !capped && !lifted) {
      take(caps, repo, ruleIndex)
      if (leavesOpen(chain.units)) markOpen(caps, ruleIndex, key)
    }
  }
  return { queue, units, skipped, allowances }
}

/** The group `found` ranks: its lead, its rule and what earlier runs left on its items. */
function readGroup(
  run: PlanRun,
  rules: Rule[],
  found: Ranked[],
  units: PlannedUnit[],
  waiting: (e: Ranked) => boolean,
): Group {
  const ours = found.flatMap((e) => e.item.linkedPrs).find((p) => p.ours)
  // An awaywork PR taken by a rule leads its feature: that rule decides, its key names the unit.
  const pickup = ours && found.find((e) => isAwayworkPr(e.item))
  const ranked = pickup ? [pickup, ...found.filter((e) => e !== pickup)] : found
  const items = ranked.map((e) => e.item)
  const lead = items[0] as Item
  const ruleIndex = ranked[0]?.rule ?? 0
  const rule = rules[ruleIndex] as Rule
  const oneOff = ruleIndex === run.queue.length
  const card =
    rule.deliver === 'plan'
      ? items.flatMap((item) => {
          const state = planState(item, planLimits(run, item))
          return state ? [{ item, ...state }] : []
        })[0]
      : undefined
  const prs = items.flatMap((i) => i.linkedPrs)
  const keys = items.map((i) => `${i.source}:${i.key}`)
  // A one-off opens only a new branch's draft, so it never goes on with one.
  const draft =
    !oneOff && !pickup && ours?.left?.items.some((k) => keys.includes(k)) ? ours.left : undefined
  // What an earlier run left for this one: its draft, else a report's `continue` result, which goes on though its items didn't change.
  const result = draft ? undefined : latestResult(lead)
  const id = slug(lead.key)
  // A report's post that waits holds its rule, whatever else changed on the card.
  const posted =
    rule.deliver === 'report' && !lead.task
      ? items.flatMap((item) => {
          const post = reportPost(item, rule.skill)
          return post ? [{ item, answer: postAnswer(post) }] : []
        })[0]
      : undefined
  return {
    items,
    lead,
    rule,
    ruleIndex,
    itemRules: ranked.map((e) => e.rule),
    id,
    oneOff,
    prs,
    ours,
    pickup: !!pickup,
    waitedOn: found.some(waiting),
    draft,
    left: draft ?? (result?.status === 'continue' ? result : undefined),
    card,
    posted,
    stack: prs.length === 0 ? stackTarget(lead, units) : undefined,
    waitsFor: prs.length === 0 ? openedElsewhere(lead) : [],
    steps: thenSteps(rule, id),
  }
}

/** `run --skill`'s rule, for the one item it names: no delivery, on_done, wait, gates, thread or post of its own. */
const oneOffRule = (skill: string): Rule => ({
  skill,
  where: {},
  provider: [],
  skills: [],
  instructions: [],
})

/** A rule's `then` steps with their unit ids, a loop's round by round. */
function thenSteps(rule: Rule, id: string) {
  return (rule.then ?? []).flatMap((entry, at): ChainStep[] => {
    if (!isLoop(entry)) return [{ written: entry, id: `${id}-${slug(entry.skill)}` }]
    const { until, max } = entry
    const skills = entry.loop.map((s) => s.skill)
    return Array.from({ length: max }, (_, r) =>
      entry.loop.map((written, step) => {
        const round = r + 1
        const loop = { at, round, step, skills, until, max }
        return { written, id: `${id}-${slug(written.skill)}-${round}`, loop }
      }),
    ).flat()
  })
}

/** A `then` step as written, its unit id and, in a loop, its round. */
export interface ChainStep {
  written: ThenStep
  id: string
  loop?: LoopRound
}

/** What the units planned so far took under the run's caps, and how many of them each provider was routed. */
interface Caps {
  routed: Record<string, number>
  perRepo: Record<string, number>
  perRule: Record<number, number>
  counted: number
  /** What's open, once each by the URL you'd open or, for tasks, by card: standing, then taken this run. */
  open: { total: Set<string>; perRule: Record<number, Set<string>> }
}

/** A unit counts once toward `units_max_open`: a card for all its tasks, else the URL left open, else the unit itself. */
const openKey = ({ task }: Item, url: string) =>
  task ? `${task.parent.source}:${task.parent.key}` : url

/** Whether a chain opens a PR or pushes, or reports and waits or may: a plain report or a pending review leaves nothing open. */
const leavesOpen = (units: PlannedUnit[]) =>
  units.some(
    ({ unit }) => unit.waits !== undefined || !['report', 'pending_review'].includes(unit.deliver),
  )

function markOpen(caps: Caps, ruleIndex: number, key: string) {
  caps.open.total.add(key)
  caps.open.perRule[ruleIndex] = (caps.open.perRule[ruleIndex] ?? new Set()).add(key)
}

/** The first cap a chain of the rule in the repo would go over, as why it's skipped. */
function overCap(
  caps: Caps,
  run: PlanRun,
  group: Group,
  repo: string,
  key: string,
): string | undefined {
  const { config } = run
  const { rule, ruleIndex } = group
  const cap = [
    { name: 'limits.units', max: config.limits.units, count: caps.counted },
    {
      name: 'limits.units_per_repo',
      max: config.limits.units_per_repo,
      count: caps.perRepo[repo] ?? 0,
    },
    { name: `rule #${ruleIndex + 1} units`, max: rule.units, count: caps.perRule[ruleIndex] ?? 0 },
    ...(landsOnOpen(group)
      ? []
      : openCaps(caps, config.limits.units_max_open, rule, ruleIndex, key)),
  ].find((c) => c.max !== undefined && c.count >= c.max)
  return cap && `over the cap: ${cap.name} is ${cap.max}`
}

/** The open caps a unit with this key would add to: not one whose count already holds the key, as a card's later tasks. */
function openCaps(
  caps: Caps,
  total: number | undefined,
  rule: Rule,
  ruleIndex: number,
  key: string,
) {
  const own = caps.open.perRule[ruleIndex] ?? new Set()
  return [
    { name: 'limits.units_max_open', max: total, set: caps.open.total },
    { name: `rule #${ruleIndex + 1} units_max_open`, max: rule.units_max_open, set: own },
  ]
    .filter((c) => !c.set.has(key))
    .map(({ name, max, set }) => ({ name, max, count: set.size }))
}

function take(caps: Caps, repo: string, ruleIndex: number) {
  caps.counted++
  caps.perRepo[repo] = (caps.perRepo[repo] ?? 0) + 1
  caps.perRule[ruleIndex] = (caps.perRule[ruleIndex] ?? 0) + 1
}

/** Each card's tasks back to back, where the first of them ranks, in the order `order` lists them: a task runs right after the one whose PR it stacks on. */
function inBlocks(groups: Ranked[][], order: Item[]): Ranked[][] {
  const taskIn = (g: Ranked[]) => g.find((e) => e.item.task)?.item
  const cardOf = (g: Ranked[]) => taskIn(g)?.task?.parent
  const at = (g: Ranked[]) => order.indexOf(taskIn(g) as Item)
  const out: Ranked[][] = []
  for (const g of groups) {
    const card = cardOf(g)
    if (!card) out.push(g)
    else if (!out.some((o) => cardOf(o) === card))
      out.push(...groups.filter((o) => cardOf(o) === card).sort((a, b) => at(a) - at(b)))
  }
  return out
}

/** The model a rule sets for a provider on this attempt: the list's entry for it. */
export function modelFor(models: Step['model'], provider: string, attempt = 0): string | undefined {
  const set = models?.[provider]
  return Array.isArray(set) ? set[attempt] : set
}

/** The models a step tries on a provider in turn: the rule's pair, else its one model or the provider's own. */
export function modelsFor(
  models: Step['model'],
  provider: string,
  providers: { id: string; model?: string }[],
) {
  const set = models?.[provider]
  return Array.isArray(set) ? set : [set ?? providers.find((c) => c.id === provider)?.model]
}

/** E.g. `matched no rule; closest #2 fix: checks is passing, wants failing`, or the last report rule done with it. */
export function noRuleReason(item: Item, queue: Rule[]): SkipReason {
  const done = queue.findLastIndex((r) => matches(r, item) && doneWith(r, item))
  const post = done >= 0 && !isAwayworkPr(item) && doneWith(queue[done] as Rule, item)
  if (post) {
    const how = 'went' in post.state ? 'its result went ahead' : 'you approved its result'
    return {
      kind: 'approved',
      reason: `#${done + 1} ${queue[done]?.skill} doesn't run again: ${how}; to run it again, delete that post on ${postsOn(item)}`,
      url: postsOn(item),
    }
  }
  const closest = closestRule(item, queue)
  const ours = isAwayworkPr(item)
  const kind = ours ? 'waiting_for_review' : 'no_rule'
  const why = ours ? `waiting for review: awaywork PR ${item.url} is open` : 'matched no rule'
  const url = ours ? { url: item.url, since: item.linkedPrs[0]?.headAt } : {}
  if (!closest) return { kind, reason: why, ...url }
  const rule = queue[closest.rule] as Rule
  const failed = describeFailed(rule.where, item, closest.failed)
  return {
    kind,
    reason: `${why}; closest #${closest.rule + 1} ${rule.skill}: ${failed.join('; ')}`,
    ...url,
  }
}

function describeFailed(where: Where, item: Item, keys: string[], outer = TOP): string[] {
  const scope = within(where, outer)
  return keys.map((key) => {
    if (key === 'any') {
      const entries = (where[key] as Where[]).map((w) =>
        describeFailed(w, item, failedIn(w, item, scope), scope).join(', '),
      )
      return `none of any matched: (${entries.join(') (')})`
    }
    const want = (where[key] ?? implicitWhere[key]) as WhereValue
    // A text field can be a whole Markdown body; the plan keeps one line per item.
    if (typeof want === 'object' && !Array.isArray(want) && isMatch(want))
      return `${key} wants ${describeWant(want)}`
    return `${key} is ${describeValue(fieldValue(item, key))}, wants ${describeWant(want)}`
  })
}

function describeWant(want: WhereValue): string {
  if (typeof want === 'object' && !Array.isArray(want))
    return 'not' in want ? `not ${describeWant(want.not)}` : describeComparison(want)
  return [want].flat().join('|')
}

function describeValue(value: unknown): string {
  if (value === undefined || value === null) return 'unset'
  return Array.isArray(value) ? value.join('|') || 'empty' : String(value)
}

/** E.g. `implement → loop(review ⇄ fix) → docs`. */
export function describeChain(chain: PlannedUnit[]): string {
  return chain
    .filter((p) => !p.loop || (p.loop.round === 1 && p.loop.step === 0))
    .map((p) => (p.loop ? `loop(${p.loop.skills.join(' ⇄ ')})` : p.unit.skill))
    .join(' → ')
}

export function slug(key: string): string {
  return key
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

/** `api#5` for an `owner/repo#n` key, its repo's name without the owner; any other key as is. */
export const shortRef = ({ key }: Pick<Item, 'key'>) =>
  key.replace(/^[^/\s]+\/(?=[^/\s]+#\d+$)/, '')

/** Whether `name` names the chain with this head id, rule and items: a step's id or an item. */
const namesChain = (id: string, rule: Rule, items: Item[], name: string) =>
  [id, ...thenSteps(rule, id).map((s) => s.id)].some((u) => namesUnit(u, items, name))

/** Whether `name` names a unit with this id and these items: the id or an item, in any case. */
export const namesUnit = (id: string, items: Item[], name: string) =>
  id === name.toLowerCase() || items.some((i) => isNamed(i, name))

/** Whether `name` is the item's key, `source:key` or short ref, in any case, and nothing looser. */
export const isNamed = (item: Item, name: string) =>
  [item.key, `${item.source}:${item.key}`, shortRef(item)].some(
    (n) => n.toLowerCase() === name.toLowerCase(),
  )
