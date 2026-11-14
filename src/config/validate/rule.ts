import type { z } from 'zod'
import type { ConfigShape } from '#config/schema'
import { builtinSkills } from '#core/skills'
import type { Rule } from '#core/types'
import { ruleSteps, ruleThread } from '#plan/queue'
import { lookback, matchesOpen } from '#plan/where'
import { isCommand } from '#sources/command'
import { sourceFor } from '#sources/index'
import { routines } from '#sources/routines'
import { checkRuleWhere } from './where'

/** What the whole config tells a rule's checks. */
type Known = {
  providerIds: string[]
  commandIds: string[]
  sourceIds: string[]
  bitbucket: boolean
}

/** A built-in skill whose merge awaywork makes itself, like `sync`. */
const merges = (skill: string) => !!builtinSkills[skill]?.merge

/** Rule `i` of the queue, its checks in the order their issues are reported. */
export function checkRule(
  cfg: ConfigShape,
  ctx: z.RefinementCtx,
  r: Rule,
  i: number,
  known: Known,
) {
  const { sourceIds } = known
  const at = ['queue', i]
  if (r.source && !sourceIds.includes(r.source))
    ctx.addIssue({
      code: 'custom',
      path: [...at, 'source'],
      message: `source "${r.source}" is not configured`,
    })
  checkDeliver(ctx, r, at, known)
  checkChain(cfg, ctx, r, at, known)
  checkPosts(cfg, ctx, r, at, known)
  checkRuleGates(cfg, ctx, r, at)
  if (r.source === routines.id && r.on_done)
    ctx.addIssue({
      code: 'custom',
      path: [...at, 'on_done'],
      message:
        'a routine has no tracker to post a result on or move: drop on_done; its report stays in the run, and notify can send it on',
    })
  checkTasks(cfg, ctx, r, at)
  checkRuleWhere(cfg, ctx, r, at, sourceIds)
}

/** The deliver Bitbucket or a merge skill rules out, and plan_tasks without deliver: plan. */
function checkDeliver(
  ctx: z.RefinementCtx,
  r: Rule,
  at: (string | number)[],
  { bitbucket }: Known,
) {
  if (bitbucket && r.deliver === 'push')
    ctx.addIssue({
      code: 'custom',
      path: [...at, 'deliver'],
      message:
        "push isn't available on Bitbucket: twg reads neither branch restrictions nor auto-merge, so awaywork can't check them; use draft_pr",
    })
  if (bitbucket && r.deliver === 'pending_review')
    ctx.addIssue({
      code: 'custom',
      path: [...at, 'deliver'],
      message:
        "pending_review isn't available on Bitbucket: awaywork leaves pending reviews on GitHub only; use report",
    })
  if (merges(r.skill) && r.deliver !== 'push')
    ctx.addIssue({
      code: 'custom',
      path: [...at, 'deliver'],
      message: `${r.skill} merges your PR's base and pushes the merge onto your PR: it needs deliver: push`,
    })
  if (merges(r.skill) && Array.isArray(r.then) && r.then.length > 0)
    ctx.addIssue({
      code: 'custom',
      path: [...at, 'then'],
      message: `${r.skill} is awaywork's own merge, not a model's step: it takes no then`,
    })
  if (merges(r.skill) && r.quota)
    ctx.addIssue({
      code: 'custom',
      path: [...at, 'quota'],
      message: `${r.skill} is awaywork's own merge, which only spends quota on a conflict: drop quota`,
    })
  if (r.plan_tasks !== undefined && r.deliver !== 'plan')
    ctx.addIssue({
      code: 'custom',
      path: [...at, 'plan_tasks'],
      message: 'plan_tasks needs deliver: plan: it caps the tasks of the plan the rule writes',
    })
}

/** Each step of the rule's chain: not a merge, not run twice, routed to providers and MCP servers it has. */
function checkChain(
  cfg: ConfigShape,
  ctx: z.RefinementCtx,
  r: Rule,
  at: (string | number)[],
  { providerIds, commandIds }: Known,
) {
  // A `then` that failed to parse is still raw here; its own issues say why.
  const chain = Array.isArray(r.then) ? ruleSteps(r) : [{ step: r, at: [] }]
  // Round ids (`<unit>-<skill>-<n>`) can't collide with plain steps', only with other rounds'.
  const inLoop = (path: (string | number)[]) => path[2] === 'loop'
  chain.forEach(({ step: s, at: path }, j) => {
    const stepAt = [...at, ...path]
    const earlier = chain.findIndex(
      (c) => c.step.skill === s.skill && inLoop(c.at) === inLoop(path),
    )
    if (j > 0 && merges(s.skill))
      ctx.addIssue({
        code: 'custom',
        path: [...stepAt, 'skill'],
        message: `${s.skill} is awaywork's own merge, a rule of its own: not a then step`,
      })
    if (earlier < j)
      ctx.addIssue({
        code: 'custom',
        path: [...stepAt, 'skill'],
        message: inLoop(path)
          ? `"${s.skill}" already runs in a loop of this chain`
          : `"${s.skill}" already runs earlier in this chain`,
      })
    for (const p of s.provider ?? [])
      if (!providerIds.includes(p))
        ctx.addIssue({
          code: 'custom',
          path: [...stepAt, 'provider'],
          message: `provider "${p}" is not configured`,
        })
    for (const name of s.mcp ?? [])
      if (!Object.hasOwn(cfg.mcp, name))
        ctx.addIssue({
          code: 'custom',
          path: [...stepAt, 'mcp'],
          message: `MCP server "${name}" is not configured`,
        })
    for (const p of Object.keys(s.model ?? {}))
      if (!providerIds.includes(p))
        ctx.addIssue({
          code: 'custom',
          path: [...stepAt, 'model', p],
          message: `provider "${p}" is not configured`,
        })
      else if (commandIds.includes(p))
        ctx.addIssue({
          code: 'custom',
          path: [...stepAt, 'model', p],
          message: `no model for the command provider "${p}": put it in its command`,
        })
    // A step that sets neither runs as the rule, already checked.
    if (s !== r && s.mcp === undefined && s.provider === undefined) return
    const mcp = s.mcp ?? r.mcp ?? []
    const provider = s.provider ?? r.provider
    const routed = provider.length > 0 ? provider : providerIds
    const command = routed.find((p) => commandIds.includes(p))
    if (mcp.length > 0 && command)
      ctx.addIssue({
        code: 'custom',
        path: [...stepAt, s.mcp ? 'mcp' : 'provider'],
        message: `the command provider "${command}" gets no MCP servers: route this step to another provider with \`provider\``,
      })
  })
}

/** Where the rule's output goes: an open item, a source that writes or a thread, and wait and post. */
function checkPosts(
  cfg: ConfigShape,
  ctx: z.RefinementCtx,
  r: Rule,
  at: (string | number)[],
  { sourceIds, bitbucket }: Known,
) {
  const finishedOnly = lookback(r.where) !== undefined && !matchesOpen(r.where)
  if ((r.deliver === 'push' || r.deliver === 'pending_review') && finishedOnly)
    ctx.addIssue({
      code: 'custom',
      path: [...at, 'deliver'],
      message: `${r.deliver} needs an open PR, and this rule matches only merged or closed items; use report, draft_pr or pr`,
    })
  if (r.deliver === 'plan' && finishedOnly)
    ctx.addIssue({
      code: 'custom',
      path: [...at, 'deliver'],
      message:
        'plan waits for your reply on an open item, and this rule matches only merged or closed items; use report',
    })
  // A rule whose posts go to a thread needs no source that writes.
  const silent =
    r.source &&
    !ruleThread(r) &&
    sourceIds.includes(r.source) &&
    !sourceFor(r.source, cfg.sources[r.source])?.write
  const threadable = !bitbucket && r.source !== routines.id ? ', or thread: github' : ''
  if (r.deliver === 'plan' && silent)
    ctx.addIssue({
      code: 'custom',
      path: [...at, 'deliver'],
      message: `plan posts on the item, and ${r.source} can't write to its items; use report${threadable}`,
    })
  if (r.thread === 'github' && bitbucket)
    ctx.addIssue({
      code: 'custom',
      path: [...at, 'thread'],
      message:
        "thread: github opens an issue in the item's repo, and this config's repos are on Bitbucket; a custom thread host can take its posts instead",
    })
  const host = ruleThread(r)
  const custom = host && host !== 'github' ? cfg.sources[host] : undefined
  if (host && host !== 'github' && !(isCommand(custom) && custom.thread))
    ctx.addIssue({
      code: 'custom',
      path: [...at, 'thread'],
      message: `thread is item, github or a custom source with thread: true, and ${host} isn't one`,
    })
  if (r.thread !== undefined && 'planned' in r.where)
    ctx.addIssue({
      code: 'custom',
      path: [...at, 'thread'],
      message: "thread goes on the plan's rule: its tasks post where the plan did",
    })
  // A post waits by `wait` only as a plan's or a report's, a task's only when a gate fires, and the PR rules' PR is already the decision.
  const posts = (r.deliver === 'plan' || r.deliver === 'report') && !('planned' in r.where)
  if (r.wait !== undefined && !posts)
    ctx.addIssue({
      code: 'custom',
      path: [...at, 'wait'],
      message:
        'planned' in r.where
          ? "wait goes on the plan's rule: a task's approval is the plan's"
          : 'wait needs deliver: plan or report: a PR is already the decision',
    })
  if (r.gates && r.deliver === 'pending_review')
    ctx.addIssue({
      code: 'custom',
      path: [...at, 'gates'],
      message:
        'gates check commits or a post, and pending_review leaves neither: the review stays yours to submit',
    })
  if (r.post !== undefined && !posts)
    ctx.addIssue({
      code: 'custom',
      path: [...at, 'post'],
      message: 'post needs deliver: plan or report: a PR body is always full',
    })
  if (
    r.post !== undefined &&
    posts &&
    r.deliver === 'report' &&
    r.wait !== true &&
    !r.gates &&
    r.on_done?.comment !== 'result'
  )
    ctx.addIssue({
      code: 'custom',
      path: [...at, 'post'],
      message:
        'post shapes a post, and this report posts nothing: add wait: true, gates or on_done: { comment: result }, or drop post',
    })
  if (r.post === 'summary' && !cfg.store)
    ctx.addIssue({
      code: 'custom',
      path: [...at, 'post'],
      message: 'post: summary pins files in a store: add a top-level store, or drop post',
    })
  // A task posts where its plan did.
  if (posts && r.deliver === 'report' && (r.wait || r.gates) && silent)
    ctx.addIssue({
      code: 'custom',
      path: [...at, r.wait ? 'wait' : 'gates'],
      message: `a report that waits posts on the item, and ${r.source} can't write to its items${threadable && '; add thread: github'}`,
    })
}

/** The rule's own gates: changed only with a diff, and no name a shared gate has. */
function checkRuleGates(cfg: ConfigShape, ctx: z.RefinementCtx, r: Rule, at: (string | number)[]) {
  const noDiff = r.deliver === 'plan' || r.deliver === 'report'
  const shared = [cfg.gates, ...Object.values(cfg.repos).map((p) => p.gates)]
  for (const [name, g] of Object.entries(r.gates ?? {})) {
    if (g.changed && noDiff)
      ctx.addIssue({
        code: 'custom',
        path: [...at, 'gates', name, 'changed'],
        message: `a ${r.deliver} has no diff: changed needs commits, on a rule that opens a PR or pushes, or in a top-level or repo gate`,
      })
    if (shared.some((gates) => Object.hasOwn(gates, name)))
      ctx.addIssue({
        code: 'custom',
        path: [...at, 'gates', name],
        message: `a top-level or repo gate is named ${name} too: name this one otherwise`,
      })
  }
}

/** A plan's tasks: a rule to take them, a deliver that finishes them, and a branch that stays put. */
function checkTasks(cfg: ConfigShape, ctx: z.RefinementCtx, r: Rule, at: (string | number)[]) {
  const takers = cfg.queue?.filter(
    (q) => 'planned' in q.where && (!q.source || !r.source || q.source === r.source),
  )
  if (r.deliver === 'plan' && !takers?.length)
    ctx.addIssue({
      code: 'custom',
      path: [...at, 'deliver'],
      message:
        "plan's tasks need a rule to take them: add one whose where names planned, e.g. { skill: implement, where: { planned: true } }",
    })
  const taskDelivers = ['draft_pr', 'pr', 'report']
  if ('planned' in r.where && r.deliver && !taskDelivers.includes(r.deliver))
    ctx.addIssue({
      code: 'custom',
      path: [...at, 'deliver'],
      message: `a plan's task opens its own PR, or reports on the card, and that's how awaywork knows it's done: deliver draft_pr, pr or report, not ${r.deliver}`,
    })
  if (r.deliver === 'plan' && r.on_done?.comment)
    ctx.addIssue({
      code: 'custom',
      path: [...at, 'on_done', 'comment'],
      message:
        "the plan comment is a plan rule's result, so a second comment would repeat it: use move alone",
    })
  // A task's PR is found by its branch, so the branch must stay put when a re-plan retitles the task.
  const templates = r.branch
    ? [r.branch]
    : [cfg.branch, ...Object.values(cfg.repos).flatMap((p) => p.branch ?? [])]
  const moving = 'planned' in r.where && templates.find((t) => /\{(title|type)\}/.test(t))
  if (moving)
    ctx.addIssue({
      code: 'custom',
      path: [...at, 'branch'],
      message: `a plan's task keeps its PR by its branch, which ${moving} renders from the task's title or skill too: set branch on this rule from {key} alone, e.g. away/{key}`,
    })
  const taskBranches = new Set(
    cfg.queue
      ?.filter((q) => 'planned' in q.where && (!q.source || !r.source || q.source === r.source))
      .map((q) => q.branch),
  )
  if ('planned' in r.where && taskBranches.size > 1)
    ctx.addIssue({
      code: 'custom',
      path: [...at, 'branch'],
      message:
        'a re-plan may hand a task another skill, and so another planned rule, which must find its PR on the same branch: set the same branch on every planned rule for its source, or on none',
    })
}
