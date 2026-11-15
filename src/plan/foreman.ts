import type { Config } from '#config/schema'
import type { Origin, SkillCatalog } from '#core/skills'
import type { Condition, Item, Rule, Step, ThenStep, Unit, Where, WhereValue } from '#core/types'
import { postAnswer, reportPost } from '#posts/posts'
import type { Moved } from '#posts/report'
import type { Allowance } from '#quota/budget'
import { committingStep, expandPlans, planLimits } from '#tasks/fanout'
import { latestResult, planState } from '#tasks/plan-file'
import { globToRegExp } from '#util/glob'
import type { Attempts } from './attempts'
import { chainUnits, landing } from './chain'
import { holdsOn, openedElsewhere, postsOn, refusal, stackTarget } from './holds'
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

export interface Skipped {
  item: Item
  kind: SkipKind
  reason: string
  /** The PR it waits on for review: one the item links, the PR awaywork pushed onto, or the item itself; or the item awaywork asked its questions or posted its plan on. */
  url?: string
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
  config: Config
  items: Item[]
  allowances: Record<string, Allowance>
  skills: SkillCatalog
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
  const { config, allowances, skips = {}, now = Date.now(), only = {} } = input
  const onlyRepo = only.repo === undefined ? undefined : globToRegExp(only.repo)
  const queue = config.queue ?? []
  const expanded = expandPlans(input.items, config, queue, input.skills, skips)
  const name = only.named
  // A task you name of a card you skipped runs; the card and its other tasks stay skipped.
  const namedTasks =
    name === undefined
      ? []
      : expandPlans(input.items, config, queue, input.skills).items.filter((item) => {
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
  const caps: Caps = { routed: {}, perRepo: {}, perRule: {}, counted: 0 }

  // A post that waits holds its card for its rule only: the card's linked items rank on their own.
  const waiting = (e: Ranked) => waitsOn(rules[e.rule] as Rule, e.item)
  const takenHere = [...ranked, ...picked.map((item) => ({ item, rule: queue.length }))]
  for (const found of inBlocks(dedupe(takenHere, waiting), candidates)) {
    const ours = found.flatMap((e) => e.item.linkedPrs).find((p) => p.ours)
    // An awaywork PR taken by a rule leads its feature: that rule decides, its key names the unit.
    const pickup = ours && found.find((e) => isAwayworkPr(e.item))
    const group = pickup ? [pickup, ...found.filter((e) => e !== pickup)] : found
    const items = group.map((e) => e.item)
    const ruleIndex = group[0]?.rule ?? 0
    const rule = rules[ruleIndex] as Rule
    const oneOff = ruleIndex === queue.length
    if (only.rule !== undefined && ruleIndex + 1 !== only.rule) continue
    if (only.soon && rule.run !== 'soon') continue
    if (only.units && !only.units.includes(slug(items[0]?.key ?? ''))) continue
    const skip = (kind: SkipKind, reason: string, url?: string) =>
      skipped.push(...items.map((item) => ({ item, kind, reason, ...(url && { url }) })))
    const card =
      rule.deliver === 'plan'
        ? items.flatMap((item) => {
            const state = planState(item, planLimits(config, queue, item, input.skills))
            return state ? [{ item, ...state }] : []
          })[0]
        : undefined
    const id = slug(items[0]?.key ?? '')
    // An approved plan runs as its tasks, so naming its card lifts nothing.
    const named =
      name !== undefined && card?.state !== 'approved' && namesChain(id, rule, items, name)
    const prs = items.flatMap((i) => i.linkedPrs)
    // awaywork's own draft for these items, which it left for a later run.
    const keys = items.map((i) => `${i.source}:${i.key}`)
    // A one-off opens only a new branch's draft, so it never goes on with one.
    const draft =
      !oneOff && !pickup && ours?.left?.items.some((k) => keys.includes(k)) ? ours.left : undefined
    // What an earlier run left for this one: its draft, else a report's `continue` result, which goes on though its items didn't change.
    const result = draft ? undefined : latestResult(items[0] as Item)
    const left = draft ?? (result?.status === 'continue' ? result : undefined)
    const stack = prs.length === 0 ? stackTarget(items[0] as Item, units) : undefined
    const waitsFor = prs.length === 0 ? openedElsewhere(items[0] as Item) : []
    // A report's post that waits holds its rule, whatever else changed on the card.
    const posted =
      rule.deliver === 'report' && !items[0]?.task
        ? items.flatMap((item) => {
            const post = reportPost(item, rule.skill)
            return post ? [{ item, answer: postAnswer(post) }] : []
          })[0]
        : undefined
    const held = holdsOn({
      items,
      rule,
      skips,
      attempts: input.attempts ?? {},
      now,
      soon: !!only.soon,
      ours,
      pickup: !!pickup,
      waitedOn: found.some(waiting),
      draft,
      left,
      card,
      posted,
      stack,
      waitsFor,
      units,
    })
    const hold = held.find((h) => !(named && h.liftable))
    if (hold) {
      skip(hold.kind, hold.reason, hold.url)
      continue
    }
    // A unit you name goes past its holds, taking no room under the caps a run without the name would have left.
    const lifted = held.length > 0 || (!!items[0] && namedTasks.includes(items[0]))
    const committing = committingStep(rule, input.skills)
    const pr = (draft && ours) || (committing ? prs.find((p) => p.mine) : undefined) || prs[0]
    const repo = pr?.repo ?? items.map((i) => i.fields.repo).find((r) => typeof r === 'string')
    if (!repo) {
      skip('no_repo', 'no repo: no linked PR or repo field')
      continue
    }
    if (onlyRepo && !onlyRepo.test(repo)) continue
    const at = landing({
      config,
      rule,
      skills: input.skills,
      items,
      repo,
      pr,
      committing,
      onto: stack?.pr,
      draft,
    })
    const refused = refusal(config, rule, input.skills, items, at)
    if (refused) {
      skip(refused.kind, refused.reason)
      continue
    }
    const capped = overCap(caps, config, rule, ruleIndex, repo)
    if (capped && !named) {
      skip('over_cap', capped)
      continue
    }
    const chain = chainUnits({ config, queue, skills: input.skills, allowances }, caps.routed, {
      rule,
      ruleIndex,
      itemRules: group.map((e) => e.rule),
      items,
      id,
      steps: thenSteps(rule, id),
      oneOff,
      at,
      draft,
      left,
      card,
      posted,
      after: stack?.after,
      waitsFor,
    })
    units.push(...chain.units)
    if (chain.counts && !capped && !lifted) take(caps, repo, ruleIndex)
  }
  return { queue, units, skipped, allowances }
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
  return (rule.then ?? []).flatMap(
    (entry, at): { written: ThenStep; id: string; loop?: LoopRound }[] => {
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
    },
  )
}

/** What the units planned so far took under the run's caps, and how many of them each provider was routed. */
interface Caps {
  routed: Record<string, number>
  perRepo: Record<string, number>
  perRule: Record<number, number>
  counted: number
}

/** The first cap a chain of the rule in the repo would go over, as why it's skipped. */
function overCap(
  caps: Caps,
  config: Config,
  rule: Rule,
  ruleIndex: number,
  repo: string,
): string | undefined {
  const cap = [
    { name: 'limits.units', max: config.limits.units, count: caps.counted },
    {
      name: 'limits.units_per_repo',
      max: config.limits.units_per_repo,
      count: caps.perRepo[repo] ?? 0,
    },
    { name: `rule #${ruleIndex + 1} units`, max: rule.units, count: caps.perRule[ruleIndex] ?? 0 },
  ].find((c) => c.max !== undefined && c.count >= c.max)
  return cap && `over the cap: ${cap.name} is ${cap.max}`
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

/** E.g. `matched no rule; closest #2 fix: checks is passing, wants failing`, or the last report rule done with it. */
export function noRuleReason(item: Item, queue: Rule[]): Omit<Skipped, 'item'> {
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
  const url = ours ? { url: item.url } : {}
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
