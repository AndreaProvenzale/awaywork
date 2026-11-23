import { isValidRef } from '#core/branch'
import type { Item, PrRef, Rule, TaskPr } from '#core/types'
import { commentKind, questionsAsked } from '#posts/comments'
import type { DraftLeft } from '#posts/footer'
import { reportPost, taskPost } from '#posts/posts'
import { gatesNeverRun } from '#tasks/fanout'
import { elsewhere, type PlanState, planThread } from '#tasks/plan-file'
import {
  byHand,
  gaveUpUntil,
  type Leftover,
  MAX_ATTEMPTS,
  pushedOnto,
  unchangedSince,
} from './attempts'
import type { Landing } from './chain'
import type { ChainStep, PlannedUnit, PlanRun, SkipKind, SkipReason } from './foreman'
import { repoListed, settingsFor } from './repos'
import { describeSkip, type Skip } from './skips'

/** A plan rule's item with a plan on it, and where that plan stands. */
export type Card = { item: Item } & PlanState

/** A report's post on an item, and your answer to it. */
export interface Posted {
  item: Item
  answer: string
}

/** Where a task after another's `opened` starts: that task's open PR, else its chain earlier in this run. */
export interface StackTarget {
  onto: string
  pr?: TaskPr
  after?: PlannedUnit
}

/** The items one chain takes, the rule taking them, and what earlier runs left on them: read once per group. */
export interface Group {
  items: Item[]
  /** The item that names the unit: awaywork's PR when the rule took it up, else the first. */
  lead: Item
  rule: Rule
  ruleIndex: number
  /** Each item's own rule, by index. */
  itemRules: number[]
  id: string
  /** Picked with `run --skill`: its rule is the one-off past the queue. */
  oneOff: boolean
  /** The PRs its items link. */
  prs: PrRef[]
  /** awaywork's PR among the items' links, and whether one of the items is it. */
  ours?: PrRef
  pickup: boolean
  /** Whether a post of the group's rule waits on one of its items. */
  waitedOn: boolean
  /** awaywork's own draft for these items, which it left for a later run. */
  draft?: DraftLeft
  left?: Leftover
  card?: Card
  posted?: Posted
  stack?: StackTarget
  /** Its `opened` tasks in other repos with no PR yet. */
  waitsFor: string[]
  /** Its rule's `then` steps. */
  steps: ChainStep[]
}

/** Why a group makes no unit; a unit you name goes past a `liftable` one. */
export interface Hold extends SkipReason {
  liftable?: boolean
}

/**
 * Every hold on a group, in the order the plan checks them: the first one naming the unit can't lift holds it.
 * Its checks all run, so each must be pure and not throw.
 */
export function holdsOn(run: PlanRun, group: Group, units: PlannedUnit[]): Hold[] {
  const { items, lead: item, rule, ours, draft, left, card, posted, stack } = group
  const { attempts } = run
  const out: Hold[] = []
  const skippedByUser = items
    .map((item) => `${item.source}:${item.key}`)
    .find((key) => run.skips[key])
  if (skippedByUser)
    out.push({
      kind: 'skipped_by_you',
      reason: describeSkip(skippedByUser, run.skips[skippedByUser] as Skip),
      url: pushedOnto(items, attempts)?.url,
      liftable: true,
    })
  // A post the unit depends on that awaywork couldn't read back decides nothing yet: no attempt counts.
  const unread = items.flatMap((i) => dependedPosts(i, rule)).find((c) => c?.pinned?.failed)
    ?.pinned?.failed
  if (unread) out.push({ kind: 'store_failed', reason: unread })
  if (ours && !group.pickup && !draft && !group.waitedOn)
    out.push({
      kind: 'waiting_for_review',
      reason: `waiting for review: awaywork PR ${ours.url} is open`,
      url: ours.url,
      since: ours.headAt,
    })
  const where = (draft && ours?.url) || item.url
  const stop = left && byHand(left, { head: ours?.head })
  if (left && stop) {
    const what = draft ? `awaywork's draft ${where}` : "awaywork's result"
    const or = draft ? ', or mark it ready' : ''
    out.push({
      kind: stop.kind,
      reason: `${what} says ${left.status}, but ${stop.why}: finish it by hand${or}`,
      url: where,
    })
  }
  const goesOn = left?.status === 'continue'
  // A soon run reacts to an item changing, and a `continue` isn't one.
  if (goesOn && run.soon)
    out.push({
      kind: 'continues_later',
      reason: `goes on from ${where} in the next window run`,
      url: where,
    })
  const pushed = pushedOnto(items, attempts)
  if (pushed)
    out.push({
      kind: 'waiting_for_review',
      reason: `waiting for review: awaywork pushed onto your PR ${pushed.url}`,
      url: pushed.url,
      since: pushed.headAt,
      liftable: true,
    })
  // Read off the item, not attempts, so a runner without state waits too, and awaywork's comment doesn't count as a change; a task's questions wait on its card.
  const asked = items.flatMap((i) => {
    const questions = i.task ? undefined : questionsAsked(i)
    return questions ? [{ item: i, questions }] : []
  })[0]
  if (asked)
    out.push({
      kind: 'waiting_for_answer',
      reason: `waiting for your answer on ${postsOn(asked.item)}`,
      url: postsOn(asked.item),
      since: asked.questions.at,
    })
  const unplanned =
    stack && !stack.pr && !stack.after
      ? stack.onto
      : group.waitsFor.find((id) => !taskChain(units, item, id))
  if (unplanned) {
    const taskDraft = item.task?.parent.taskPrs?.[unplanned]?.left
    out.push({
      kind: 'waiting_for_task',
      reason: `waiting for task ${unplanned}'s ${taskDraft ? `draft, which says ${taskDraft.status}` : 'PR to open'}`,
    })
  }
  if (card?.state === 'waiting')
    out.push({
      kind: 'waiting_for_approval',
      reason: `waiting for your approval of the plan on ${postsOn(card.item)}`,
      url: postsOn(card.item),
      since: planThread(card.item)?.plan.at,
    })
  if (card?.state === 'invalid')
    out.push({
      kind: 'invalid_plan',
      reason: `plan refused: ${card.problem}`,
      url: postsOn(card.item),
    })
  if (posted?.answer === 'waiting')
    out.push({
      kind: 'waiting_for_approval',
      reason: `waiting for your approval of ${rule.skill}'s result on ${postsOn(posted.item)}`,
      url: postsOn(posted.item),
      since: reportPost(posted.item, rule.skill)?.post.at,
    })
  // Closing a task's PR doesn't touch the card, nor editing a pinned file: its re-plan is due all the same.
  const replan = card?.state === 'replan'
  const stale = items.some((i) => rulePost(i, rule)?.pinned?.stale)
  const since = items.map((item) => unchangedSince(item, rule.skill, attempts))
  if (since.every(Boolean) && !goesOn && !replan && !stale)
    out.push({
      kind: 'unchanged',
      reason: `unchanged since run ${since.sort().at(-1)}`,
      liftable: true,
    })
  const retries = items.map((i) => gaveUpUntil(i, rule.skill, attempts, run.now))
  if (retries.every(Boolean))
    out.push({
      kind: 'gave_up',
      reason: `gave up after ${MAX_ATTEMPTS} attempts; next try on ${new Date(Math.min(...retries.map(Number))).toLocaleDateString('sv-SE')}`,
      liftable: true,
    })
  return out
}

export const waits: SkipKind[] = [
  'waiting_for_review',
  'waiting_for_answer',
  'waiting_for_approval',
]

/** The URL of what awaywork left open on the group, the one you'd open: its open PR, else the post that waits. */
export const openUrl = ({ ours }: Group, held: Hold[]): string | undefined =>
  ours?.url ?? held.find((h) => waits.includes(h.kind))?.url

/** Whether you answered the item's questions and no result of awaywork's came since. */
const answered = ({ comments }: Item) => {
  const asked = comments.findLastIndex((c) => commentKind(c) === 'questions')
  const since = comments.slice(asked + 1)
  return (
    asked >= 0 &&
    since.some((c) => !c.bot && !commentKind(c)) &&
    !since.some((c) => commentKind(c) === 'result')
  )
}

/** Whether the group lands on something already open, which a cap on open units never holds: the rerun after your answer or feedback, a task of a card with a PR already. */
export const landsOnOpen = ({ lead, card, posted, items }: Group): boolean =>
  Object.keys(lead.task?.parent.taskPrs ?? {}).length > 0 ||
  card?.state === 'feedback' ||
  posted?.answer === 'feedback' ||
  items.some(answered)

/** Why the chain can't deliver where it lands, the first the plan checks. */
export function refusal(run: PlanRun, group: Group, at: Landing): Hold | undefined {
  const { config, catalog } = run
  const { rule, items } = group
  const { repo, pr, committing, merging } = at
  // Its thread opens in the repo an item names, so that one is listed too.
  const unlisted = [repo, ...items.map((i) => i.fields.repo)].find(
    (r) => typeof r === 'string' && !repoListed(config.repos, r),
  )
  if (unlisted)
    return {
      kind: 'unlisted_repo',
      reason: `${unlisted} isn't in repos: awaywork works only in the repos listed there`,
    }
  if (rule.deliver === 'pending_review' && !pr)
    return { kind: 'refused_delivery', reason: 'deliver pending_review: no pull request to review' }
  // A declared gate never stays off unsaid: one on a chain that only reports runs under deliver: report alone.
  const ungated = gatesNeverRun(rule, catalog)
  if (ungated) return { kind: 'refused_delivery', reason: ungated }
  if (!isValidRef(at.branch)) {
    const template = rule.branch ?? settingsFor(config.repos, repo).branch ?? config.branch
    return {
      kind: 'invalid_branch',
      reason: `branch template ${template} renders an invalid name "${at.branch}"`,
    }
  }
  if (merging && (rule.deliver !== 'push' || rule.then?.length))
    return {
      kind: 'refused_delivery',
      reason: `${rule.skill} merges your PR's base: it needs deliver: push, no then`,
    }
  const refused = committing && deliveryRefusal(at)
  if (refused)
    return {
      kind: 'refused_delivery',
      reason: committing === rule ? refused : `${refused}, and ${committing.skill} commits`,
    }
  if (merging && !pr?.into)
    return {
      kind: 'refused_delivery',
      reason: `${rule.skill}: ${pr?.url} names no base branch to merge`,
    }
}

/** Why a chain can't publish commits onto its base: only onto the developer's own PR in the repo. */
function deliveryRefusal({
  deliver,
  base,
  foreign,
  fork,
}: Pick<Landing, 'deliver' | 'base' | 'foreign' | 'fork'>): string | undefined {
  if (deliver === 'push' && !base) return 'deliver push: no PR of yours to push onto'
  if (foreign) return `deliver ${deliver}: ${base} is someone else's PR`
  if (fork) return `deliver ${deliver}: ${base} is on a fork`
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
export function stackTarget(item: Item, units: PlannedUnit[]): StackTarget | undefined {
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
export function openedElsewhere(item: Item): string[] {
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

/** Where you answer awaywork's posts on the item: its thread issue, else the item. */
export const postsOn = (item: Item): string => item.thread?.url ?? item.url
