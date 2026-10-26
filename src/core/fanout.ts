import type { Config } from '../config/schema.js'
import { defaultType, renderBranch } from './branch.js'
import { commentMarkdown, footerItems, waitingTasks } from './footer.js'
import type { SkipKind, Skipped } from './foreman.js'
import {
  cardTasks,
  type PlanLimits,
  plannedSkills,
  planState,
  TASK_SKILL,
  type Task,
} from './plan.js'
import { isLoop, ruleFor } from './queue.js'
import { resolveSkill, type SkillCatalog } from './skills.js'
import type { BranchPr, Item, Rule, TaskPr, ThenStep } from './types.js'

/** A card's repo: its first linked PR's, else its `repo` field. */
export const cardRepo = (item: Item): string | undefined =>
  item.linkedPrs[0]?.repo ?? (typeof item.fields.repo === 'string' ? item.fields.repo : undefined)

/** What a plan on the card is checked against. */
export const planLimits = (config: Config, queue: Rule[], card: Item): PlanLimits => ({
  maxTasks: config.limits.plan_tasks,
  repo: cardRepo(card),
  skills: plannedSkills(queue, card.source),
})

/** Whether a rule's step reports instead of committing: every step of a `report`, `pending_review` or `plan` rule does, and one whose skill says so. */
export const stepReports =
  (rule: Rule, skills: SkillCatalog) =>
  (step: ThenStep): boolean =>
    rule.deliver === 'report' ||
    rule.deliver === 'pending_review' ||
    rule.deliver === 'plan' ||
    resolveSkill(step.skill, skills)?.meta.deliver === 'report'

/** The rule's first step that commits, if one does. */
export function committingStep(rule: Rule, skills: SkillCatalog): ThenStep | undefined {
  const steps = [rule, ...(rule.then ?? []).flatMap((e) => (isLoop(e) ? e.loop : [e]))]
  return steps.find((s) => !stepReports(rule, skills)(s))
}

/** The branch a rule's slice on the item publishes on: the template with the item and the type of the step it starts with. */
export function branchName(
  config: Config,
  rule: Rule,
  repo: string,
  item: Item,
  step: ThenStep | undefined,
  skills: SkillCatalog,
): string {
  const template = rule.branch ?? config.repos[repo]?.branch ?? config.branch
  const type = (step && resolveSkill(step.skill, skills)?.meta.type) || defaultType
  return renderBranch(template, item, type)
}

/** A task of the plan on the card as an item: the card's source, URL, ownership, fields and comments, its own title and description. */
export function taskItem(card: Item, task: Task, plan: Task[] = [task], notes = ''): Item {
  return {
    source: card.source,
    id: `${card.id}/${task.id}`,
    key: `${card.key}/${task.id}`,
    type: 'task',
    title: task.title,
    description: task.description ?? '',
    url: card.url,
    status: card.status,
    ...(card.assignee && { assignee: card.assignee }),
    reviewers: card.reviewers,
    labels: card.labels,
    comments: card.comments,
    linkedPrs: [],
    // Never a closing line: the card outlives each of its tasks' PRs.
    link: `Part of ${card.url}`,
    fields: { ...card.fields, repo: cardRepo(card) },
    ...(card.mine && { mine: card.mine }),
    task: {
      parent: card,
      id: task.id,
      skill: task.skill ?? TASK_SKILL,
      notes,
      plan: plan.map((t) => ({ id: t.id, title: t.title, after: Object.keys(t.after ?? {}) })),
    },
    raw: card.raw,
  }
}

/** Where the plan stands on a card a `deliver: plan` rule takes. */
function planCard(item: Item, queue: Rule[], config: Config) {
  return queue[ruleFor(queue, item)]?.deliver === 'plan'
    ? planState(item, planLimits(config, queue, item))
    : undefined
}

/**
 * The branch of each task any plan on a card names, for the cards a `deliver: plan` rule takes
 * that are yours: the forge looks up each task's PR by it. None on Bitbucket, whose fan-out waits.
 */
export function taskBranches(
  items: Item[],
  config: Config,
  queue: Rule[],
  skills: SkillCatalog,
): { card: Item; id: string; key: string; repo: string; branch: string }[] {
  if (config.sources.bitbucket) return []
  return items.flatMap((card) => {
    if (!card.mine || queue[ruleFor(queue, card)]?.deliver !== 'plan') return []
    return cardTasks(card).flatMap((t) => {
      const item = taskItem(card, t)
      const rule = queue[ruleFor(queue, item)]
      const repo = item.fields.repo
      if (!rule || typeof repo !== 'string') return []
      const branch = branchName(config, rule, repo, item, committingStep(rule, skills), skills)
      return [{ card, id: t.id, key: item.key, repo, branch }]
    })
  })
}

/** The task's PR among those on its branch: the one whose footer names it, an open or merged one first. */
export function taskPr(
  prs: BranchPr[],
  task: { card: Item; key: string; repo: string; branch: string },
): TaskPr | undefined {
  const named = prs.filter((pr) => footerItems(pr.body).includes(`${task.card.source}:${task.key}`))
  const pr = named.find((p) => p.open) ?? named.find((p) => p.merged) ?? named.at(-1)
  if (!pr) return undefined
  return {
    repo: task.repo,
    number: pr.number,
    url: pr.url,
    branch: task.branch,
    ours: true,
    mine: true,
    trusted: true,
    fork: false,
    state: pr.open ? 'open' : pr.merged ? 'merged' : 'closed',
    ...(pr.closedAt && { closedAt: pr.closedAt }),
  }
}

/**
 * Replaces each card a `deliver: plan` rule took whose plan you approved with its tasks, which go
 * down the queue like any item. The card itself skips, as do the tasks that make no unit: merged,
 * waiting on another's merge, or held while any task's questions wait. A card whose tasks' PRs
 * closed unmerged since stays, to plan again.
 */
export function expandPlans(
  items: Item[],
  config: Config,
  queue: Rule[],
): { items: Item[]; skipped: Skipped[] } {
  const out: Item[] = []
  const skipped: Skipped[] = []
  const skip = (item: Item, kind: SkipKind, reason: string, url?: string) =>
    skipped.push({ item, kind, reason, ...(url && { url }) })
  for (const card of items) {
    const state = planCard(card, queue, config)
    if (state?.state !== 'approved') {
      out.push(card)
      continue
    }
    if (!card.mine) {
      skip(card, 'refused_delivery', "plan approved, but the card isn't yours: its tasks don't run")
      continue
    }
    if (config.sources.bitbucket) {
      skip(
        card,
        'refused_delivery',
        "plan approved, but its tasks don't run on Bitbucket yet: awaywork can't read their merged and closed PRs there",
      )
      continue
    }
    const prs = card.taskPrs
    if (!prs) {
      skip(card, 'fanned_out', "plan approved, but its tasks' PRs couldn't be read")
      continue
    }
    const { tasks } = state.plan
    const asked = waitingTasks(card)
    const states: string[] = []
    // The card's own skip goes first, its tasks' under it.
    const at = skipped.length
    for (const t of tasks) {
      const item = taskItem(card, t, tasks, state.notes)
      const pr = prs[t.id]
      const blocker = Object.keys(t.after ?? {}).find((id) => prs[id]?.state !== 'merged')
      if (pr?.state === 'merged') {
        states.push(`${t.id} merged`)
        skip(item, 'task_merged', `merged in ${pr.url}`, pr.url)
      } else if (asked.length) {
        states.push(`${t.id} waits for your answer`)
        const named = asked.map((id) => `task ${id}'s`).join(' and ')
        skip(
          item,
          'waiting_for_answer',
          `waiting for your answer to ${named} questions on ${card.url}`,
          card.url,
        )
      } else if (pr) {
        states.push(`${t.id} PR open`)
        out.push({ ...item, linkedPrs: [pr] })
      } else if (blocker) {
        states.push(`${t.id} waits for ${blocker}`)
        skip(
          item,
          'waiting_for_task',
          `waiting for task ${blocker}'s PR to merge`,
          prs[blocker]?.url,
        )
      } else {
        states.push(`${t.id} no PR yet`)
        out.push(item)
      }
    }
    const done = tasks.every((t) => prs[t.id]?.state === 'merged')
    skipped.splice(at, 0, {
      item: card,
      ...(done
        ? { kind: 'all_tasks_merged', reason: 'all tasks merged: close or move the card' }
        : { kind: 'fanned_out', reason: `fanned out: ${states.join(', ')}` }),
      url: card.url,
    })
  }
  return { items: out, skipped }
}

/** A task's `item.md`: the task, where it sits in the plan with your approve notes, the card, and the card's comments, its tasks' questions headed by task. */
export function taskMarkdown(item: Item): string {
  const task = item.task
  if (!task) return ''
  const card = task.parent
  const listed = task.plan.map(
    (t) =>
      `- \`${t.id}\`: ${t.title}${t.id === task.id ? ' (this task)' : ''}${t.after.length ? `, after ${t.after.join(', ')} merged` : ''}`,
  )
  const notes = task.notes ? `\n\nYour notes on approving it:\n\n${task.notes}` : ''
  const comments = card.comments.map(commentMarkdown)
  return [
    `# ${item.key}: ${item.title}\n\n${item.url}\n\n${item.description}\n`,
    `\n## The plan\n\nThis is task \`${task.id}\` of the plan you approved on ${card.key}. Each task is its own item, with its own branch and PR. Its tasks:\n\n${listed.join('\n')}${notes}\n`,
    `\n## The card: ${card.key}, ${card.title}\n${card.description ? `\n${card.description}\n` : ''}`,
    ...(comments.length ? ['\n## Comments\n', ...comments] : []),
  ].join('')
}
