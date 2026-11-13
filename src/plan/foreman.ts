import type { Config } from '../config/schema.js'
import { isValidRef } from '../core/branch.js'
import { type Origin, resolveSkill, type SkillCatalog } from '../core/skills.js'
import type {
  Condition,
  Deliver,
  Gate,
  Item,
  Rule,
  Step,
  TaskPr,
  ThenStep,
  Unit,
  Where,
  WhereValue,
} from '../core/types.js'
import { awaitsAnswer } from '../posts/comments.js'
import { postAnswer, reportPost, taskPost } from '../posts/posts.js'
import type { Moved } from '../posts/report.js'
import { type Allowance, quotaFacts, route } from '../quota/budget.js'
import {
  branchName,
  committingStep,
  expandPlans,
  gatesNeverRun,
  planLimits,
  stepReports,
} from '../tasks/fanout.js'
import { elsewhere, latestResult, planState, planThread } from '../tasks/plan-file.js'
import { globToRegExp } from '../util/glob.js'
import {
  type Attempts,
  byHand,
  gaveUpUntil,
  MAX_ATTEMPTS,
  pushedOnto,
  unchangedSince,
} from './attempts.js'
import { holds } from './condition.js'
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
} from './queue.js'
import { repoListed, settingsFor } from './repos.js'
import { describeSkip, type Skip } from './skips.js'
import {
  describeComparison,
  failedIn,
  fieldValue,
  implicitWhere,
  isMatch,
  TOP,
  within,
} from './where.js'

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
  const routed: Record<string, number> = {}
  const perRepo: Record<string, number> = {}
  const perRule: Record<number, number> = {}
  let counted = 0

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
    const limits = (item: Item) => planLimits(config, queue, item, input.skills)
    const card =
      rule.deliver === 'plan'
        ? items.flatMap((item) => {
            const state = planState(item, limits(item))
            return state ? [{ item, ...state }] : []
          })[0]
        : undefined
    const id = slug(items[0]?.key ?? '')
    const steps = thenSteps(rule, id)
    // An approved plan runs as its tasks, so naming its card lifts nothing.
    const named =
      name !== undefined && card?.state !== 'approved' && namesChain(id, rule, items, name)
    let lifted = !!items[0] && namedTasks.includes(items[0])
    // True when it stays held; a unit you name goes past, taking no room under the caps a run without the name would have left.
    const hold = (kind: SkipKind, reason: string, url?: string) => {
      if (named) lifted = true
      else skip(kind, reason, url)
      return !named
    }
    const attempts = input.attempts ?? {}
    const skippedByUser = items
      .map((item) => `${item.source}:${item.key}`)
      .find((key) => skips[key])
    if (
      skippedByUser &&
      hold(
        'skipped_by_you',
        describeSkip(skippedByUser, skips[skippedByUser] as Skip),
        pushedOnto(items, attempts)?.url,
      )
    )
      continue
    // A post the unit depends on that awaywork couldn't read back decides nothing yet: no attempt counts.
    const unread = items.flatMap((i) => dependedPosts(i, rule)).find((c) => c?.pinned?.failed)
      ?.pinned?.failed
    if (unread) {
      skip('store_failed', unread)
      continue
    }
    const prs = items.flatMap((i) => i.linkedPrs)
    // awaywork's own draft for these items, which it left for a later run.
    const keys = items.map((i) => `${i.source}:${i.key}`)
    // A one-off opens only a new branch's draft, so it never goes on with one.
    const draft =
      !oneOff && !pickup && ours?.left?.items.some((k) => keys.includes(k)) ? ours.left : undefined
    if (ours && !pickup && !draft && !found.some(waiting)) {
      skip('waiting_for_review', `waiting for review: awaywork PR ${ours.url} is open`, ours.url)
      continue
    }
    // What an earlier run left for this one: its draft, else a report's `continue` result, which goes on though its items didn't change.
    const result = draft ? undefined : latestResult(items[0] as Item)
    const left = draft ?? (result?.status === 'continue' ? result : undefined)
    const where = (draft && ours?.url) || (items[0] as Item).url
    const stop = left && byHand(left, { head: ours?.head })
    if (left && stop) {
      const what = draft ? `awaywork's draft ${where}` : "awaywork's result"
      const or = draft ? ', or mark it ready' : ''
      skip(stop.kind, `${what} says ${left.status}, but ${stop.why}: finish it by hand${or}`, where)
      continue
    }
    const goesOn = left?.status === 'continue'
    // A soon run reacts to an item changing, and a `continue` isn't one.
    if (goesOn && only.soon) {
      skip('continues_later', `goes on from ${where} in the next window run`, where)
      continue
    }
    const pushed = pushedOnto(items, attempts)
    if (
      pushed &&
      hold(
        'waiting_for_review',
        `waiting for review: awaywork pushed onto your PR ${pushed.url}`,
        pushed.url,
      )
    )
      continue
    // Read off the item, not attempts, so a runner without state waits too, and awaywork's comment doesn't count as a change; a task's questions wait on its card.
    const asked = items.find((i) => !i.task && awaitsAnswer(i))
    if (asked) {
      skip('waiting_for_answer', `waiting for your answer on ${postsOn(asked)}`, postsOn(asked))
      continue
    }
    const stack = prs.length === 0 ? stackTarget(items[0] as Item, units) : undefined
    const waitsFor = prs.length === 0 ? openedElsewhere(items[0] as Item) : []
    const unplanned =
      stack && !stack.pr && !stack.after
        ? stack.onto
        : waitsFor.find((id) => !taskChain(units, items[0] as Item, id))
    if (unplanned) {
      const taskDraft = items[0]?.task?.parent.taskPrs?.[unplanned]?.left
      skip(
        'waiting_for_task',
        `waiting for task ${unplanned}'s ${taskDraft ? `draft, which says ${taskDraft.status}` : 'PR to open'}`,
      )
      continue
    }
    const ontoPr = stack?.pr
    const after = stack?.after
    if (card?.state === 'waiting') {
      skip(
        'waiting_for_approval',
        `waiting for your approval of the plan on ${postsOn(card.item)}`,
        postsOn(card.item),
      )
      continue
    }
    if (card?.state === 'invalid') {
      skip('invalid_plan', `plan refused: ${card.problem}`, postsOn(card.item))
      continue
    }
    // A report's post that waits holds its rule, whatever else changed on the card.
    const posted =
      rule.deliver === 'report' && !items[0]?.task
        ? items.flatMap((item) => {
            const post = reportPost(item, rule.skill)
            return post ? [{ item, answer: postAnswer(post) }] : []
          })[0]
        : undefined
    if (posted?.answer === 'waiting') {
      skip(
        'waiting_for_approval',
        `waiting for your approval of ${rule.skill}'s result on ${postsOn(posted.item)}`,
        postsOn(posted.item),
      )
      continue
    }
    // Closing a task's PR doesn't touch the card, nor editing a pinned file: its re-plan is due all the same.
    const replan = card?.state === 'replan'
    const stale = items.some((i) => rulePost(i, rule)?.pinned?.stale)
    const since = items.map((item) => unchangedSince(item, rule.skill, attempts))
    if (
      since.every(Boolean) &&
      !goesOn &&
      !replan &&
      !stale &&
      hold('unchanged', `unchanged since run ${since.sort().at(-1)}`)
    )
      continue
    const retries = items.map((i) => gaveUpUntil(i, rule.skill, attempts, now))
    if (
      retries.every(Boolean) &&
      hold(
        'gave_up',
        `gave up after ${MAX_ATTEMPTS} attempts; next try on ${new Date(Math.min(...retries.map(Number))).toLocaleDateString('sv-SE')}`,
      )
    )
      continue
    // A skill commits unless it reports; `deliver: report`, `pending_review` and `plan` make every step report.
    const review = rule.deliver === 'pending_review'
    const planned = rule.deliver === 'plan'
    const reports = stepReports(rule, input.skills)
    const committing = committingStep(rule, input.skills)
    const deliver = rule.deliver === 'push' || rule.deliver === 'pr' ? rule.deliver : 'draft_pr'
    const pr = (draft && ours) || (committing ? prs.find((p) => p.mine) : undefined) || prs[0]
    const repo = pr?.repo ?? items.map((i) => i.fields.repo).find((r) => typeof r === 'string')
    if (!repo) {
      skip('no_repo', 'no repo: no linked PR or repo field')
      continue
    }
    if (onlyRepo && !onlyRepo.test(repo)) continue
    // Its thread opens in the repo an item names, so that one is listed too.
    const unlisted = [repo, ...items.map((i) => i.fields.repo)].find(
      (r) => typeof r === 'string' && !repoListed(config.repos, r),
    )
    if (unlisted) {
      skip(
        'unlisted_repo',
        `${unlisted} isn't in repos: awaywork works only in the repos listed there`,
      )
      continue
    }
    if (review && !pr) {
      skip('refused_delivery', 'deliver pending_review: no pull request to review')
      continue
    }
    // A declared gate never stays off unsaid: one on a chain that only reports runs under deliver: report alone.
    const ungated = gatesNeverRun(rule, input.skills)
    if (ungated) {
      skip('refused_delivery', ungated)
      continue
    }
    const template = rule.branch ?? settingsFor(config.repos, repo).branch ?? config.branch
    // A chain's name takes the type of its first committing step; the list's words keep it a valid ref.
    const branch = branchName(config, rule, repo, items[0] as Item, committing, input.skills)
    if (!isValidRef(branch)) {
      skip('invalid_branch', `branch template ${template} renders an invalid name "${branch}"`)
      continue
    }
    const base = pr?.branch ?? ontoPr?.branch ?? ''
    const foreign = pr ? !pr.mine : false
    const fork = pr?.fork ? { number: pr.number, head: pr.head } : undefined
    // A merging skill named otherwise than the built-in, which the config can't check.
    const merging = resolveSkill(rule.skill, input.skills)?.meta.merge
    if (merging && (rule.deliver !== 'push' || rule.then?.length)) {
      skip(
        'refused_delivery',
        `${rule.skill} merges your PR's base: it needs deliver: push, no then`,
      )
      continue
    }
    const refused = committing && deliveryRefusal(deliver, base, foreign, !!fork)
    if (refused) {
      skip(
        'refused_delivery',
        committing === rule ? refused : `${refused}, and ${committing.skill} commits`,
      )
      continue
    }
    if (merging && !pr?.into) {
      skip('refused_delivery', `${rule.skill}: ${pr?.url} names no base branch to merge`)
      continue
    }
    const overCap = () => {
      const cap = [
        { name: 'limits.units', max: config.limits.units, count: counted },
        {
          name: 'limits.units_per_repo',
          max: config.limits.units_per_repo,
          count: perRepo[repo] ?? 0,
        },
        { name: `rule #${ruleIndex + 1} units`, max: rule.units, count: perRule[ruleIndex] ?? 0 },
      ].find((c) => c.max !== undefined && c.count >= c.max)
      return cap && `over the cap: ${cap.name} is ${cap.max}`
    }
    const capped = overCap()
    if (capped && !named) {
      skip('over_cap', capped)
      continue
    }

    // A post after your feedback, or a task's PR closed, waits for you whatever `wait` says.
    const again = card?.state === 'feedback' || replan || posted?.answer === 'feedback'
    // A report that neither waits nor has gates of its own posts as a plain result, `wait: false` too.
    const decides = planned || (rule.deliver === 'report' && (rule.wait === true || !!rule.gates))
    const waits = decides ? again || (rule.wait ?? planned) : undefined
    // Only a post reads the step's summary: a report rule posts when it decides or comments its result.
    const lean =
      (decides || (rule.deliver === 'report' && rule.on_done?.comment === 'result')) &&
      !items[0]?.task &&
      (rule.post ?? (config.store ? 'summary' : 'full')) === 'summary'
    // A resumed task's draft stays stacked on the task below it while that one is open.
    const below =
      draft && items[0]?.task?.onto && items[0].task.parent.taskPrs?.[items[0].task.onto]
    const stackedOn = ontoPr?.url ?? (below && below.state === 'open' ? below.url : undefined)
    const at = {
      base,
      foreign,
      untrusted: pr ? !pr.trusted : false,
      fork,
      ...(merging && { merge: pr?.into }),
      branch: draft ? base : branch,
      ...(stackedOn && { stackedOn }),
      ...(draft &&
        pr && {
          resume: {
            url: pr.url,
            number: pr.number,
            from: draft.from,
            head: draft.head,
            status: draft.status,
          },
        }),
      ...(left && { continued: left.continued }),
    }
    const add = (written: ThenStep, unitId: string, loop?: LoopRound) => {
      const step = written === rule ? rule : inherit(rule, written)
      const skill = resolveSkill(step.skill, input.skills)
      const providers = step.provider.length > 0 ? step.provider : config.providers.map((p) => p.id)
      // Every step is routed, as the run does, so the plan holds fallback units for all of them; a merge takes a provider only to resolve conflicts the source read.
      const routes = !at.merge || items.some((i) => i.fields.conflicts === true)
      // A one-off runs alone, so the rule units planned before it take no fallback unit from it.
      const { provider, passed } = routes
        ? route(providers, allowances, oneOff ? {} : routed)
        : { passed: [] }
      if (provider) routed[provider] = (routed[provider] ?? 0) + 1
      const settings = settingsFor(config.repos, repo)
      const unit: Unit = {
        ...at,
        id: unitId,
        verify: settings.verify,
        // Gates check what a model wrote, and a merge with no model has nothing of its; the top-level and repo ones need commits, so a plan or report takes its rule's own only.
        gates: decides
          ? gatesOf(rule.gates)
          : at.merge && !provider
            ? undefined
            : gatesOf(config.gates, settings.gates, rule.gates),
        ...(waits !== undefined && { waits }),
        ...(lean && { lean }),
        ...(oneOff && { oneOff }),
        items,
        repo,
        rule: step,
        skill: step.skill,
        skills: [...config.skills, ...step.skills],
        providers,
        instructions: [
          ...config.instructions,
          ...(settings.instructions ? [settings.instructions] : []),
          ...step.instructions,
        ],
        deliver: review ? 'pending_review' : planned ? 'plan' : reports(step) ? 'report' : deliver,
        ...(planned && { planLimits: limits(items[0] as Item) }),
      }
      const unmet = provider && written === rule && quotaUnmet(rule.quota, allowances[provider])
      units.push({
        unit,
        rule: ruleIndex,
        itemRules: group.map((e) => e.rule),
        origin: skill?.origin,
        provider,
        passed,
        ...(unmet && { quotaUnmet: unmet }),
        ...(written !== rule && { chain: id }),
        ...(loop && { loop }),
        ...(written === rule && after && { after: after.unit.id }),
        ...(written === rule && waitsFor.length > 0 && { waitsFor }),
      })
      return !!provider || !!at.merge
    }
    // A chain publishes once, so it counts once, when its first step runs.
    if (add(rule, id) && !capped && !lifted) {
      counted++
      perRepo[repo] = (perRepo[repo] ?? 0) + 1
      perRule[ruleIndex] = (perRule[ruleIndex] ?? 0) + 1
    }
    for (const step of steps) add(step.written, step.id, step.loop)
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

/** The rule's own post on the item: its plan, a task's newest result, or its skill's newest result. */
const rulePost = (i: Item, rule: Rule) =>
  i.task
    ? taskPost(i, i.task.id)
    : rule.deliver === 'plan'
      ? planThread(i)?.plan
      : reportPost(i, rule.skill)?.post

/** The posts a unit of the rule on the item stands on: the rule's own, a task's plan on its card, and the result `approved` names. */
const dependedPosts = (i: Item, rule: Rule) => [
  rulePost(i, rule),
  i.task && planThread(i)?.plan,
  typeof i.fields.approved === 'string' ? reportPost(i, i.fields.approved)?.post : undefined,
]

/** Where a task after another's `opened` starts: on that task's open PR, else after its chain earlier in this run. */
function stackTarget(
  item: Item,
  units: PlannedUnit[],
): { onto: string; pr?: TaskPr; after?: PlannedUnit } | undefined {
  const { task } = item
  if (!task?.onto) return undefined
  const pr = task.parent.taskPrs?.[task.onto]
  // A draft left for a later run holds half-done work: it stacks only once that run finished it.
  if (pr && !pr.left) return { onto: task.onto, pr }
  const after = taskChain(units, item, task.onto)
  return { onto: task.onto, ...(after && { after }) }
}

/** The chain planned so far for task `id` of the card `item` is a task of. */
export const taskChain = (units: PlannedUnit[], item: Item, id: string) =>
  units.find(
    (u) =>
      !u.chain &&
      u.unit.items.some(
        (i) => i.source === item.source && i.key === `${item.task?.parent.key}/${id}`,
      ),
  )

/** A task's `opened` tasks in other repos that have no PR yet: it waits for them without stacking. */
function openedElsewhere(item: Item): string[] {
  const task = item.task
  const own = task?.plan.find((t) => t.id === task.id)
  if (!task || !own) return []
  return elsewhere(own, task.plan)
    .filter(
      (t) =>
        own.after[t.id] === 'opened' &&
        (task.parent.taskPrs?.[t.id]?.left ?? !task.parent.taskPrs?.[t.id]),
    )
    .map((t) => t.id)
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

/** The top-level gates with the repo's and the rule's own, or a plan or report rule's alone: each level adds gates, and on a shared name a repo's globs, command and skill join the top-level ones. */
function gatesOf(...levels: (Rule['gates'] | undefined)[]): Record<string, Gate> | undefined {
  const gates = new Map<string, Gate>()
  for (const [name, g] of levels.flatMap((level) => Object.entries(level ?? {}))) {
    const gate = gates.get(name) ?? { changed: [], commands: [], skills: [], instructions: [] }
    gate.changed.push(...(g.changed ?? []))
    if (g.command) gate.commands.push(g.command)
    if (g.skill) gate.skills.push(g.skill)
    gate.instructions.push(...(g.instructions ?? []))
    gates.set(name, gate)
  }
  return gates.size ? Object.fromEntries(gates) : undefined
}

function quotaUnmet(quota: Condition | undefined, a: Allowance | undefined): string | undefined {
  if (!quota || !a) return undefined
  if (a.kind === 'fallback') return 'no quota reading'
  return holds(quota, quotaFacts(a)) ? undefined : "doesn't hold on the probe"
}

/** The model a rule sets for a provider on this attempt: the list's entry for it. */
export function modelFor(models: Step['model'], provider: string, attempt = 0): string | undefined {
  const set = models?.[provider]
  return Array.isArray(set) ? set[attempt] : set
}

/** A step with the rule's provider, model, skills, MCP servers and instructions where it sets none. */
function inherit(rule: Rule, step: ThenStep): Step {
  return {
    ...step,
    provider: step.provider ?? rule.provider,
    model: step.model ?? rule.model,
    skills: step.skills ?? rule.skills,
    mcp: step.mcp ?? rule.mcp,
    instructions: step.instructions ?? rule.instructions,
  }
}

/** Why a chain can't publish commits onto its base: only onto the developer's own PR in the repo. */
function deliveryRefusal(
  deliver: Exclude<Deliver, 'report' | 'pending_review' | 'plan'>,
  base: string,
  foreign: boolean,
  fork: boolean,
): string | undefined {
  if (deliver === 'push' && !base) return 'deliver push: no PR of yours to push onto'
  if (foreign) return `deliver ${deliver}: ${base} is someone else's PR`
  if (fork) return `deliver ${deliver}: ${base} is on a fork`
}

/** Where you answer awaywork's posts on the item: its thread issue, else the item. */
const postsOn = (item: Item): string => item.thread?.url ?? item.url

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
