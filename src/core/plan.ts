import { parse } from 'yaml'
import { z } from 'zod'
import {
  commentKind,
  commentTask,
  contractHeading,
  isApprove,
  isAwayworkComment,
  resultStatus,
} from './footer.js'
import { globToRegExp } from './glob.js'
import type { Item, TaskPr } from './types.js'

const task = z.strictObject({
  id: z.string(),
  title: z.string().min(1),
  description: z.string().optional(),
  skill: z.string().min(1).optional(),
  repo: z.string().optional(),
  after: z.record(z.string(), z.string().min(1)).optional(),
  ships: z.array(z.string()).optional(),
})
// Strict, so a later shape widens it on purpose.
const planFile = z.strictObject({ tasks: z.array(task).min(1), contract: z.string().optional() })

export type Plan = z.output<typeof planFile>
export type Task = Plan['tasks'][number]

/** Whether an `after` value is a check's name: anything but `opened` and `merged`. */
export const isCheck = (when: string) => when !== 'opened' && when !== 'merged'

/** The skill a task runs when it names none. */
export const TASK_SKILL = 'implement'

/** The contract the plan step wrote: its path under `.away/out/`, and the file. */
export interface Contract {
  name: string
  text: string
}

/** What a plan is checked against: `limits.plan_tasks`, the card's repo and the others a task may name, and, when given, the skills `planned` rules take and the retired task ids. */
export interface PlanLimits {
  maxTasks: number
  repo?: string
  /** The repos a task may name besides the card's: the forge source's globs and the config's `repos`. */
  repos?: string[]
  skills?: string[]
  /** Skills whose `planned` rule reports instead of opening a PR: a task of theirs is done by its result on the card. */
  reports?: string[]
  /** Task ids whose PR was closed without merging, with that PR's URL: no plan may reuse them. */
  retired?: Record<string, string>
}

/** What a `deliver: plan` step's prompt says about `plan.yml`; `kept` are the task ids with an open or merged PR. */
export function planContract(
  { maxTasks, repo, repos = [], skills = [], reports = [], retired = {} }: PlanLimits,
  kept: Record<string, string> = {},
): string {
  const named =
    skills.map((s) => `\`${s}\`${reports.includes(s) ? ' (reports)' : ''}`).join(', ') || 'none'
  const others = repos.map((r) => `\`${r}\``).join(', ') || 'none'
  const repoText = repo
    ? `this item's, \`${repo}\`, when unset${repos.length ? `, else one of ${others}` : ''}`
    : `every task needs one, as this item has none: one of ${others}`
  const listed = (prs: Record<string, string>) =>
    Object.entries(prs)
      .map(([id, url]) => `\`${id}\` (${url})`)
      .join(', ')
  return [
    `\`plan.yml\` is YAML: \`tasks:\`, a list of at most ${maxTasks} tasks, each with an \`id\` (lowercase letters, digits and dashes, unique), a \`title\`, and optionally a \`description\`, a \`skill\` (one of ${named}; \`${TASK_SKILL}\` when unset), a \`repo\` (${repoText}), \`ships\`, a list of repo-relative paths of files its PR will contain that tasks in other repos need, and \`after\`, a map from other task ids to \`merged\`, \`opened\` or the name of a check on that task's PR, with no cycles; and optionally \`contract:\`, the path of one file you wrote under \`.away/out/\`, e.g. \`.away/out/openapi.yaml\` with an OpenAPI diff or a schema the tasks share; no other key. \`merged\` waits, across runs, until that task's PR merges, then cuts the task from the default branch. \`opened\` waits only until that task's PR opens, which can be in the same run, right before it: in the same repo, the task's branch is cut from that task's and its PR stacks on that task's PR; in another repo, it only waits, and the task is cut from its own repo's default branch. A check's name, e.g. \`Vercel Preview\`, is \`opened\` plus that check passing on that task's PR head, across runs; a merged PR counts as passed. Write it as the forge shows it, letter for letter: anything but \`merged\` and \`opened\` is a check's name. A task's \`opened\` and check tasks in its own repo must lie on one chain, each after the one before, and it stacks on the last: web after \`api: opened\` and \`schema: opened\` needs api after \`schema: opened\`. A task in another repo than a task it names in \`after\` gets the files that task \`ships\`, read from its PR. Each task becomes its own item with its own branch and PR once the plan is approved, and every task gets the contract. awaywork checks it and posts your report, the narrative a person reads to approve the plan, the contract and \`plan.yml\` as one comment on the item.`,
    ...(reports.some((s) => skills.includes(s))
      ? [
          'A task whose skill reports opens no PR: awaywork posts its report on the item as its result, and no task may name it in `after`.',
        ]
      : []),
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
  const { contract } = parsed.data
  if (contract !== undefined && !contractName(contract))
    return { problem: `contract ${contract} isn't a file under ${OUT}` }
  const problem = tasksProblem(parsed.data.tasks, limits)
  return problem ? { problem } : { plan: parsed.data }
}

const OUT = '.away/out/'

/** A path inside a folder: relative, with no `.`, `..` or empty part. */
const inside = (path: string) => path.split('/').every((p) => p && p !== '.' && p !== '..')

/** The contract's path under `.away/out/`, e.g. `openapi.yaml`, or undefined when `path` isn't in there. */
export const contractName = (path: string): string | undefined => {
  const name = path.startsWith(OUT) ? path.slice(OUT.length) : ''
  return inside(name) ? name : undefined
}

function tasksProblem(
  tasks: Task[],
  { maxTasks, repo, repos = [], skills, reports = [], retired = {} }: PlanLimits,
): string | undefined {
  if (tasks.length > maxTasks) return `${tasks.length} tasks, over limits.plan_tasks (${maxTasks})`
  const ids = tasks.map((t) => t.id)
  const known = [...(repo ? [repo] : []), ...repos]
  const exactly = (glob: string) => new RegExp(globToRegExp(glob).source)
  for (const t of tasks) {
    // It names a child item, `ENG-2101/api`, and its branch, `away/ENG-2101-api`.
    if (!/^[a-z0-9][a-z0-9-]*$/.test(t.id))
      return `task id "${t.id}" isn't lowercase letters, digits and dashes`
    if (ids.indexOf(t.id) !== ids.lastIndexOf(t.id)) return `task id "${t.id}" is used twice`
    if (retired[t.id])
      return `task id "${t.id}" is retired: its PR ${retired[t.id]} was closed without merging`
    if (t.repo === undefined && !repo)
      return `task ${t.id}: no repo, and the card has none: name one on every task`
    if (t.repo !== undefined && !known.some((r) => exactly(r).test(t.repo ?? ''))) {
      // The repo's settings, caps and stacking all compare names exactly.
      const spelled = known.find((r) => globToRegExp(r).test(t.repo ?? ''))
      return spelled
        ? `task ${t.id}: repo ${t.repo} isn't ${spelled} as configured`
        : `task ${t.id}: repo ${t.repo} isn't the card's (${repo ?? 'none'}) or one the config names`
    }
    const outside = t.ships?.find((path) => !inside(path))
    if (outside !== undefined)
      return `task ${t.id}: ships ${outside}, which isn't a relative path without ..`
    const skill = t.skill ?? TASK_SKILL
    if (skills && !skills.includes(skill))
      return `task ${t.id}: no planned rule takes skill ${skill}`
    const unknown = Object.keys(t.after ?? {}).find((id) => !ids.includes(id))
    if (unknown) return `task ${t.id}: after names no task "${unknown}"`
  }
  for (const t of tasks) {
    const report = tasks.find((o) => t.after?.[o.id] && reports.includes(o.skill ?? TASK_SKILL))
    if (report)
      return `task ${t.id}: after names ${report.id}, which reports: it opens no PR to stack on, check or merge`
  }
  const cycle = cycleIn(tasks)
  if (cycle) return `tasks wait on each other: ${cycle.join(' → ')}`
  for (const t of tasks) {
    const opened = openedHere(t, tasks, repo)
    if (opened.length > 1 && !openedChain(t, tasks, repo)) {
      const [a, b] = opened
      return `task ${t.id}: its opened tasks ${opened.join(', ')} aren't on one chain: make each after the one before, e.g. ${b} after ${a}: opened`
    }
  }
}

/** What the stacking reads of a task: a task's plan entry will do. */
type Planned = Pick<Task, 'id' | 'after' | 'repo' | 'ships'>

/** The tasks `task` names in `after` whose repo isn't its own; `home` is the card's, a task's when it names none. */
export const elsewhere = <T extends Planned>(task: Planned, tasks: T[], home?: string): T[] =>
  tasks.filter((t) => task.after?.[t.id] && (t.repo ?? home) !== (task.repo ?? home))

/** A task's `opened` and check tasks in its own repo: those it stacks on. */
const openedHere = (task: Planned, tasks: Planned[], home?: string): string[] => {
  const away = elsewhere(task, tasks, home).map((t) => t.id)
  return Object.keys(task.after ?? {}).filter(
    (id) => task.after?.[id] !== 'merged' && !away.includes(id),
  )
}

/** A task's `opened` and check tasks in its own repo in the order they run, each after the one before, or undefined when they aren't on one chain. */
export function openedChain(task: Planned, tasks: Planned[], home?: string): string[] | undefined {
  const opened = openedHere(task, tasks, home)
  const here = (id: string) =>
    (tasks.find((t) => t.id === id)?.repo ?? home) === (task.repo ?? home)
  // Every task in its repo `id` waits on, through any `after`: a later task on the chain waits on more.
  const below = (id: string, seen = new Set<string>()): Set<string> => {
    for (const next of Object.keys(tasks.find((t) => t.id === id)?.after ?? {})) {
      if (seen.has(next) || !here(next)) continue
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

/** The task whose open PR holds task `id`'s work: `id` itself until its PR merges, then the first down its stack whose PR hasn't; undefined once all of it reached the default branch. */
export function holdingTask(
  id: string,
  tasks: Planned[],
  merged: (id: string) => boolean,
  home?: string,
): string | undefined {
  if (!merged(id)) return id
  const task = tasks.find((t) => t.id === id)
  const top = task && openedChain(task, tasks, home)?.at(-1)
  return top && top !== id ? holdingTask(top, tasks, merged, home) : undefined
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

/** The contract `name` a plan comment carries above `plan.yml`: the fenced block under its heading, or '' when there's none. */
export function contractText(comment: string, name: string): string {
  const lines = comment.replace(/\r\n/g, '\n').split('\n')
  const yaml = lines.findLastIndex((l) => l.trimEnd() === '```yaml')
  const at = lines
    .slice(0, Math.max(yaml, 0))
    .findLastIndex((l) => l.trimEnd() === contractHeading(name))
  const open = at < 0 ? -1 : lines.findIndex((l, i) => i > at && l.trim() !== '')
  const fence = lines[open]?.match(/^`{3,}/)?.[0]
  const end = fence ? lines.findIndex((l, i) => i > open && l.trimEnd() === fence) : -1
  return end < 0 ? '' : lines.slice(open + 1, end).join('\n')
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

/** The tasks whose `done` result is on the card after its plan's approval: a re-plan's approval leaves older results behind. */
export function doneTasks(item: Pick<Item, 'comments'>): string[] {
  const answer = planThread(item)?.answer
  if (!answer) return []
  return item.comments
    .slice(item.comments.indexOf(answer) + 1)
    .flatMap((c) => (resultStatus(c) === 'done' && commentTask(c)) || [])
}

/** Where a plan on the item stands, read off its comments and its tasks' PRs: a plan you edited is checked again. */
export type PlanState =
  | { state: 'waiting' }
  | { state: 'feedback' }
  | { state: 'invalid'; problem: string }
  | { state: 'approved'; plan: Plan; notes: string; contract?: Contract }
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
  const { contract: path } = checked.plan
  const name = path && contractName(path)
  const text = name ? contractText(thread.plan.body, name) : ''
  if (name && !text.trim())
    return { state: 'invalid', problem: `contract ${path} isn't in the plan comment` }
  if (!thread.answer) return { state: 'waiting' }
  const closed = checked.plan.tasks.filter((t) => item.taskPrs?.[t.id]?.state === 'closed')
  if (closed.length) return { state: 'replan', closed: closed.map((t) => t.id) }
  return {
    state: 'approved',
    plan: checked.plan,
    notes: approveNotes(thread.answer),
    ...(name && { contract: { name, text } }),
  }
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
