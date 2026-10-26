import { parse } from 'yaml'
import { z } from 'zod'
import { commentKind, isApprove, isAwayworkComment } from './footer.js'
import type { Item, TaskPr } from './types.js'

const task = z.strictObject({
  id: z.string(),
  title: z.string().min(1),
  description: z.string().optional(),
  skill: z.string().min(1).optional(),
  repo: z.string().optional(),
  after: z.record(z.string(), z.enum(['opened', 'merged'])).optional(),
})
// Strict, so a later shape widens it on purpose.
const planFile = z.strictObject({ tasks: z.array(task).min(1) })

export type Plan = z.output<typeof planFile>
export type Task = Plan['tasks'][number]

/** The skill a task runs when it names none. */
export const TASK_SKILL = 'implement'

/** What a plan is checked against: `limits.plan_tasks`, the card's repo, and, when given, the skills `planned` rules take and the retired task ids. */
export interface PlanLimits {
  maxTasks: number
  repo?: string
  skills?: string[]
  /** Skills whose `planned` rule opens no PR, so a task of theirs would never read as done. */
  noPr?: string[]
  /** Task ids whose PR was closed without merging, with that PR's URL: no plan may reuse them. */
  retired?: Record<string, string>
}

/** What a `deliver: plan` step's prompt says about `plan.yml`; `kept` are the task ids with an open or merged PR. */
export function planContract(
  { maxTasks, skills = [], retired = {} }: PlanLimits,
  kept: Record<string, string> = {},
): string {
  const named = skills.map((s) => `\`${s}\``).join(', ') || 'none'
  const listed = (prs: Record<string, string>) =>
    Object.entries(prs)
      .map(([id, url]) => `\`${id}\` (${url})`)
      .join(', ')
  return [
    `\`plan.yml\` is YAML: \`tasks:\`, a list of at most ${maxTasks} tasks, each with an \`id\` (lowercase letters, digits and dashes, unique), a \`title\`, and optionally a \`description\`, a \`skill\` (one of ${named}; \`${TASK_SKILL}\` when unset), a \`repo\` (only this unit's) and \`after\`, a map from other task ids to \`merged\` or \`opened\`, with no cycles; no other key. \`merged\` waits, across runs, until that task's PR merges, then cuts the task from the default branch. \`opened\` waits only until that task's PR opens, which can be in the same run, right before it: the task's branch is cut from that task's and its PR stacks on that task's PR. A task's \`opened\` tasks must lie on one chain, each after the one before, and it stacks on the last: web after \`api: opened\` and \`schema: opened\` needs api after \`schema: opened\`. Each task becomes its own item with its own branch and PR once the plan is approved. awaywork checks it and posts your report, the narrative a person reads to approve the plan, and \`plan.yml\` as one comment on the item.`,
    ...(Object.keys(retired).length
      ? [
          `These tasks' PRs were closed without merging, so their ids are retired and no task may reuse them: ${listed(retired)}. Plan the work again without them.`,
        ]
      : []),
    ...(Object.keys(kept).length
      ? [
          `These tasks already have a PR, open or merged: ${listed(kept)}. A task that keeps its id keeps its PR, and a merged one runs no more, so keep an id only for the same work.`,
        ]
      : []),
  ].join(' ')
}

/** The plan in `text`, or why awaywork refuses it, e.g. `task id "web" is used twice`. */
export function checkPlan(text: string, limits: PlanLimits): { plan: Plan } | { problem: string } {
  if (!text.trim()) return { problem: 'missing or empty' }
  let raw: unknown
  try {
    raw = parse(text)
  } catch (e) {
    return { problem: `not YAML: ${(e as Error).message.split('\n')[0]}` }
  }
  const parsed = planFile.safeParse(raw)
  if (!parsed.success) {
    const [issue] = parsed.error.issues
    const at = issue?.path.map(String).join('.')
    return { problem: `${at ? `${at}: ` : ''}${issue?.message}` }
  }
  const problem = tasksProblem(parsed.data.tasks, limits)
  return problem ? { problem } : { plan: parsed.data }
}

function tasksProblem(
  tasks: Task[],
  { maxTasks, repo, skills, noPr = [], retired = {} }: PlanLimits,
): string | undefined {
  if (tasks.length > maxTasks) return `${tasks.length} tasks, over limits.plan_tasks (${maxTasks})`
  const ids = tasks.map((t) => t.id)
  for (const t of tasks) {
    // It names a child item, `ENG-2101/api`, and its branch, `away/ENG-2101-api`.
    if (!/^[a-z0-9][a-z0-9-]*$/.test(t.id))
      return `task id "${t.id}" isn't lowercase letters, digits and dashes`
    if (ids.indexOf(t.id) !== ids.lastIndexOf(t.id)) return `task id "${t.id}" is used twice`
    if (retired[t.id])
      return `task id "${t.id}" is retired: its PR ${retired[t.id]} was closed without merging`
    if (t.repo !== undefined && t.repo !== repo)
      return `task ${t.id}: repo ${t.repo} isn't the card's (${repo ?? 'none'})`
    const skill = t.skill ?? TASK_SKILL
    if (noPr.includes(skill))
      return `task ${t.id}: the planned rule for skill ${skill} opens no PR, and a task is done when its PR merges`
    if (skills && !skills.includes(skill))
      return `task ${t.id}: no planned rule takes skill ${skill}`
    const unknown = Object.keys(t.after ?? {}).find((id) => !ids.includes(id))
    if (unknown) return `task ${t.id}: after names no task "${unknown}"`
  }
  const cycle = cycleIn(tasks)
  if (cycle) return `tasks wait on each other: ${cycle.join(' → ')}`
  for (const t of tasks) {
    const opened = Object.keys(t.after ?? {}).filter((id) => t.after?.[id] === 'opened')
    if (opened.length > 1 && !openedChain(t, tasks)) {
      const [a, b] = opened
      return `task ${t.id}: its opened tasks ${opened.join(', ')} aren't on one chain: make each after the one before, e.g. ${b} after ${a}: opened`
    }
  }
}

/** A task's `opened` tasks in the order they run, each after the one before, or undefined when they aren't on one chain. */
export function openedChain(task: Task, tasks: Task[]): string[] | undefined {
  const opened = Object.keys(task.after ?? {}).filter((id) => task.after?.[id] === 'opened')
  // Every task `id` waits on, through any `after`: a later task on the chain waits on more.
  const below = (id: string, seen = new Set<string>()): Set<string> => {
    for (const next of Object.keys(tasks.find((t) => t.id === id)?.after ?? {})) {
      if (seen.has(next)) continue
      seen.add(next)
      below(next, seen)
    }
    return seen
  }
  const chain = [...opened].sort((a, b) => below(a).size - below(b).size)
  return chain.every((id, i) => i === 0 || below(id).has(chain[i - 1] as string))
    ? chain
    : undefined
}

/** The plan's tasks in the order they run: each after those it waits on, else in the plan's order. */
export function runOrder(tasks: Task[]): Task[] {
  const out: Task[] = []
  const placed = (id: string) => out.some((t) => t.id === id)
  for (;;) {
    const next = tasks.find((t) => !out.includes(t) && Object.keys(t.after ?? {}).every(placed))
    if (!next) return out
    out.push(next)
  }
}

/** A path of `after` that comes back to where it started, e.g. `[api, web, api]`. */
function cycleIn(tasks: Task[]): string[] | undefined {
  const after = new Map(tasks.map((t) => [t.id, Object.keys(t.after ?? {})]))
  const clear = new Set<string>()
  const visit = (id: string, path: string[]): string[] | undefined => {
    if (path.includes(id)) return [...path.slice(path.indexOf(id)), id]
    if (clear.has(id)) return
    for (const next of after.get(id) ?? []) {
      const found = visit(next, [...path, id])
      if (found) return found
    }
    clear.add(id)
  }
  for (const t of tasks) {
    const found = visit(t.id, [])
    if (found) return found
  }
}

/** The `plan.yml` a plan comment carries: its last fenced yaml block, fences only at the start of a line. */
export function planYaml(comment: string): string {
  // A comment edited on the web can come back with CRLF line endings.
  const lines = comment.replace(/\r\n/g, '\n').split('\n')
  const start = lines.findLastIndex((l) => l.trimEnd() === '```yaml')
  const end = start < 0 ? -1 : lines.findIndex((l, i) => i > start && l.trimEnd() === '```')
  return end < 0 ? '' : lines.slice(start + 1, end).join('\n')
}

type Comment = Item['comments'][number]

/** Awaywork's newest plan comment on the item, and its answer: the first comment after it but a bot's. */
export function planThread(
  item: Pick<Item, 'comments'>,
): { plan: Comment; answer?: Comment } | undefined {
  const at = item.comments.findLastIndex((c) => commentKind(c) === 'plan')
  if (at < 0) return undefined
  const answer = item.comments.slice(at + 1).find((c) => !c.bot)
  return { plan: item.comments[at] as Comment, ...(answer && { answer }) }
}

/** Where a plan on the item stands, read off its comments and its tasks' PRs: a plan you edited is checked again. */
export type PlanState =
  | { state: 'waiting' }
  | { state: 'feedback' }
  | { state: 'invalid'; problem: string }
  | { state: 'approved'; plan: Plan; notes: string }
  /** Approved, and these tasks' PRs were closed without merging since: the plan rule plans again. */
  | { state: 'replan'; closed: string[] }

export function planState(
  item: Pick<Item, 'comments' | 'taskPrs'>,
  limits: PlanLimits,
): PlanState | undefined {
  const thread = planThread(item)
  if (!thread) return undefined
  if (thread.answer && !isApprove(thread.answer)) return { state: 'feedback' }
  // A PR closed before the plan was posted retired its id; one closed after it re-plans.
  const posted = Date.parse(thread.plan.at)
  const retired = taskPrUrls(
    item,
    (pr) => pr.state === 'closed' && Date.parse(pr.closedAt ?? '') < posted,
  )
  const checked = checkPlan(planYaml(thread.plan.body), { ...limits, retired })
  if ('problem' in checked) return { state: 'invalid', problem: checked.problem }
  if (!thread.answer) return { state: 'waiting' }
  const closed = checked.plan.tasks.filter((t) => item.taskPrs?.[t.id]?.state === 'closed')
  if (closed.length) return { state: 'replan', closed: closed.map((t) => t.id) }
  return { state: 'approved', plan: checked.plan, notes: approveNotes(thread.answer) }
}

/** The card's task ids whose PR `keep` takes, with the PR's URL. */
export const taskPrUrls = (
  item: Pick<Item, 'taskPrs'>,
  keep: (pr: TaskPr) => boolean,
): Record<string, string> =>
  Object.fromEntries(
    Object.entries(item.taskPrs ?? {}).flatMap(([id, pr]) => (keep(pr) ? [[id, pr.url]] : [])),
  )

/** Every task any of awaywork's plans on the card names, the newest plan's first, each id once: their PRs say which ids are retired. */
export function cardTasks(item: Pick<Item, 'comments'>): Task[] {
  const tasks = item.comments
    .filter((c) => commentKind(c) === 'plan')
    .reverse()
    .flatMap((c) => {
      try {
        return planFile.safeParse(parse(planYaml(c.body))).data?.tasks ?? []
      } catch {
        return []
      }
    })
  return tasks.filter((t, i) => tasks.findIndex((u) => u.id === t.id) === i)
}

/** An approve reply's lines below `approve`, without awaywork's mark. */
function approveNotes(c: Comment): string {
  const lines = c.body.trimEnd().split(/\r?\n/).slice(1)
  return (isAwayworkComment(c) ? lines.slice(0, -1) : lines).join('\n').trim()
}
