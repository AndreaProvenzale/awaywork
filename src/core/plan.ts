import { parse } from 'yaml'
import { z } from 'zod'
import { commentKind, isApprove, isAwayworkComment } from './footer.js'
import type { Item } from './types.js'

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
type Task = Plan['tasks'][number]

/** What a plan is checked against: `limits.plan_tasks` and the card's repo. */
export interface PlanLimits {
  maxTasks: number
  repo?: string
}

/** What a `deliver: plan` step's prompt says about `plan.yml`. */
export const planContract = ({ maxTasks }: PlanLimits): string =>
  `\`plan.yml\` is YAML: \`tasks:\`, a list of at most ${maxTasks} tasks, each with an \`id\` (lowercase letters, digits and dashes, unique), a \`title\`, and optionally a \`description\`, a \`skill\`, a \`repo\` (only this unit's) and \`after\`, a map from other task ids to \`opened\` or \`merged\`, with no cycles; no other key. awaywork checks it and posts your report, the narrative a person reads to approve the plan, and \`plan.yml\` as one comment on the item.`

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

function tasksProblem(tasks: Task[], { maxTasks, repo }: PlanLimits): string | undefined {
  if (tasks.length > maxTasks) return `${tasks.length} tasks, over limits.plan_tasks (${maxTasks})`
  const ids = tasks.map((t) => t.id)
  for (const t of tasks) {
    // It names a child item, `ENG-2101/api`, and its branch, `away/ENG-2101-api`.
    if (!/^[a-z0-9][a-z0-9-]*$/.test(t.id))
      return `task id "${t.id}" isn't lowercase letters, digits and dashes`
    if (ids.indexOf(t.id) !== ids.lastIndexOf(t.id)) return `task id "${t.id}" is used twice`
    if (t.repo !== undefined && t.repo !== repo)
      return `task ${t.id}: repo ${t.repo} isn't the card's (${repo ?? 'none'})`
    const unknown = Object.keys(t.after ?? {}).find((id) => !ids.includes(id))
    if (unknown) return `task ${t.id}: after names no task "${unknown}"`
  }
  const cycle = cycleIn(tasks)
  if (cycle) return `tasks wait on each other: ${cycle.join(' → ')}`
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

/** Where a plan on the item stands, read off its comments: a plan you edited is checked again. */
export type PlanState =
  | { state: 'waiting' }
  | { state: 'feedback' }
  | { state: 'invalid'; problem: string }
  | { state: 'approved'; plan: Plan; notes: string }

export function planState(item: Pick<Item, 'comments'>, limits: PlanLimits): PlanState | undefined {
  const thread = planThread(item)
  if (!thread) return undefined
  if (thread.answer && !isApprove(thread.answer)) return { state: 'feedback' }
  const checked = checkPlan(planYaml(thread.plan.body), limits)
  if ('problem' in checked) return { state: 'invalid', problem: checked.problem }
  if (!thread.answer) return { state: 'waiting' }
  return { state: 'approved', plan: checked.plan, notes: approveNotes(thread.answer) }
}

/** An approve reply's lines below `approve`, without awaywork's mark. */
function approveNotes(c: Comment): string {
  const lines = c.body.trimEnd().split(/\r?\n/).slice(1)
  return (isAwayworkComment(c) ? lines.slice(0, -1) : lines).join('\n').trim()
}
