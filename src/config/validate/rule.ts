import type { ConfigShape } from '#config/schema'
import { builtinSkills } from '#core/skills'
import type { Rule } from '#core/types'
import { ruleSteps, ruleThread } from '#plan/queue'
import { lookback, matchesOpen } from '#plan/where'
import { isCommand } from '#sources/command'
import { sourceFor } from '#sources/index'
import { routines } from '#sources/routines'
import { commandIds, type Issue, providerIds } from './issue'
import { checkRuleWhere } from './where'

/** A built-in skill whose merge awaywork makes itself, like `sync`. */
const merges = (skill: string) => !!builtinSkills[skill]?.merge

/** A queue rule, its checks in the order their issues are reported. */
export function checkRule(cfg: ConfigShape, r: Rule, issue: Issue) {
  if (r.source && !Object.hasOwn(cfg.sources, r.source))
    issue(['source'], `source "${r.source}" is not configured`)
  checkDeliver(cfg, r, issue)
  checkChain(cfg, r, issue)
  checkPosts(cfg, r, issue)
  checkRuleGates(cfg, r, issue)
  if (r.source === routines.id && r.on_done)
    issue(
      ['on_done'],
      'a routine has no tracker to post a result on or move: drop on_done; its report stays in the run, and notify can send it on',
    )
  checkTasks(cfg, r, issue)
  checkRuleWhere(cfg, r, issue)
}

/** The deliver Bitbucket or a merge skill rules out, and plan_tasks without deliver: plan. */
function checkDeliver(cfg: ConfigShape, r: Rule, issue: Issue) {
  const bitbucket = cfg.forge.id === 'bitbucket'
  if (bitbucket && r.deliver === 'push')
    issue(
      ['deliver'],
      "push isn't available on Bitbucket: twg reads neither branch restrictions nor auto-merge, so awaywork can't check them; use draft_pr",
    )
  if (bitbucket && r.deliver === 'pending_review')
    issue(
      ['deliver'],
      "pending_review isn't available on Bitbucket: awaywork leaves pending reviews on GitHub only; use report",
    )
  if (merges(r.skill) && r.deliver !== 'push')
    issue(
      ['deliver'],
      `${r.skill} merges your PR's base and pushes the merge onto your PR: it needs deliver: push`,
    )
  if (merges(r.skill) && Array.isArray(r.then) && r.then.length > 0)
    issue(['then'], `${r.skill} is awaywork's own merge, not a model's step: it takes no then`)
  if (merges(r.skill) && r.quota)
    issue(
      ['quota'],
      `${r.skill} is awaywork's own merge, which only spends quota on a conflict: drop quota`,
    )
  if (r.plan_tasks !== undefined && r.deliver !== 'plan')
    issue(
      ['plan_tasks'],
      'plan_tasks needs deliver: plan: it caps the tasks of the plan the rule writes',
    )
}

/** Each step of the rule's chain: not a merge, not run twice, routed to providers and MCP servers it has. */
function checkChain(cfg: ConfigShape, r: Rule, issue: Issue) {
  const providers = providerIds(cfg)
  const commands = commandIds(cfg)
  // A `then` that failed to parse is still raw here; its own issues say why.
  const chain = Array.isArray(r.then) ? ruleSteps(r) : [{ step: r, at: [] }]
  // Round ids (`<unit>-<skill>-<n>`) can't collide with plain steps', only with other rounds'.
  const inLoop = (path: (string | number)[]) => path[2] === 'loop'
  chain.forEach(({ step: s, at: path }, j) => {
    const earlier = chain.findIndex(
      (c) => c.step.skill === s.skill && inLoop(c.at) === inLoop(path),
    )
    if (j > 0 && merges(s.skill))
      issue(
        [...path, 'skill'],
        `${s.skill} is awaywork's own merge, a rule of its own: not a then step`,
      )
    if (earlier < j)
      issue(
        [...path, 'skill'],
        inLoop(path)
          ? `"${s.skill}" already runs in a loop of this chain`
          : `"${s.skill}" already runs earlier in this chain`,
      )
    for (const p of s.provider ?? [])
      if (!providers.includes(p)) issue([...path, 'provider'], `provider "${p}" is not configured`)
    for (const name of s.mcp ?? [])
      if (!Object.hasOwn(cfg.mcp, name))
        issue([...path, 'mcp'], `MCP server "${name}" is not configured`)
    for (const p of Object.keys(s.model ?? {}))
      if (!providers.includes(p)) issue([...path, 'model', p], `provider "${p}" is not configured`)
      else if (commands.includes(p))
        issue(
          [...path, 'model', p],
          `no model for the command provider "${p}": put it in its command`,
        )
    // A step that sets neither runs as the rule, already checked.
    if (s !== r && s.mcp === undefined && s.provider === undefined) return
    const mcp = s.mcp ?? r.mcp ?? []
    const provider = s.provider ?? r.provider
    const routed = provider.length > 0 ? provider : providers
    const command = routed.find((p) => commands.includes(p))
    if (mcp.length > 0 && command)
      issue(
        [...path, s.mcp ? 'mcp' : 'provider'],
        `the command provider "${command}" gets no MCP servers: route this step to another provider with \`provider\``,
      )
  })
}

/** Where the rule's output goes: an open item, a source that writes or a thread, and wait and post. */
function checkPosts(cfg: ConfigShape, r: Rule, issue: Issue) {
  const bitbucket = cfg.forge.id === 'bitbucket'
  const finishedOnly = lookback(r.where) !== undefined && !matchesOpen(r.where)
  if ((r.deliver === 'push' || r.deliver === 'pending_review') && finishedOnly)
    issue(
      ['deliver'],
      `${r.deliver} needs an open PR, and this rule matches only merged or closed items; use report, draft_pr or pr`,
    )
  if (r.deliver === 'plan' && finishedOnly)
    issue(
      ['deliver'],
      'plan waits for your reply on an open item, and this rule matches only merged or closed items; use report',
    )
  // A rule whose posts go to a thread needs no source that writes.
  const silent =
    r.source &&
    !ruleThread(r) &&
    Object.hasOwn(cfg.sources, r.source) &&
    !sourceFor(r.source, cfg.sources[r.source])?.write
  const threadable = !bitbucket && r.source !== routines.id ? ', or thread: github' : ''
  if (r.deliver === 'plan' && silent)
    issue(
      ['deliver'],
      `plan posts on the item, and ${r.source} can't write to its items; use report${threadable}`,
    )
  if (r.thread === 'github' && bitbucket)
    issue(
      ['thread'],
      "thread: github opens an issue in the item's repo, and this config's repos are on Bitbucket; a custom thread host can take its posts instead",
    )
  const host = ruleThread(r)
  const custom = host && host !== 'github' ? cfg.sources[host] : undefined
  if (host && host !== 'github' && !(isCommand(custom) && custom.thread))
    issue(
      ['thread'],
      `thread is item, github or a custom source with thread: true, and ${host} isn't one`,
    )
  if (r.thread !== undefined && 'planned' in r.where)
    issue(['thread'], "thread goes on the plan's rule: its tasks post where the plan did")
  // A post waits by `wait` only as a plan's or a report's, a task's only when a gate fires, and the PR rules' PR is already the decision.
  const posts = (r.deliver === 'plan' || r.deliver === 'report') && !('planned' in r.where)
  if (r.wait !== undefined && !posts)
    issue(
      ['wait'],
      'planned' in r.where
        ? "wait goes on the plan's rule: a task's approval is the plan's"
        : 'wait needs deliver: plan or report: a PR is already the decision',
    )
  if (r.gates && r.deliver === 'pending_review')
    issue(
      ['gates'],
      'gates check commits or a post, and pending_review leaves neither: the review stays yours to submit',
    )
  if (r.post !== undefined && !posts)
    issue(['post'], 'post needs deliver: plan or report: a PR body is always full')
  if (
    r.post !== undefined &&
    posts &&
    r.deliver === 'report' &&
    r.wait !== true &&
    !r.gates &&
    r.on_done?.comment !== 'result'
  )
    issue(
      ['post'],
      'post shapes a post, and this report posts nothing: add wait: true, gates or on_done: { comment: result }, or drop post',
    )
  if (r.post === 'summary' && !cfg.store)
    issue(['post'], 'post: summary pins files in a store: add a top-level store, or drop post')
  // A task posts where its plan did.
  if (posts && r.deliver === 'report' && (r.wait || r.gates) && silent)
    issue(
      [r.wait ? 'wait' : 'gates'],
      `a report that waits posts on the item, and ${r.source} can't write to its items${threadable && '; add thread: github'}`,
    )
}

/** The rule's own gates: changed only with a diff, and no name a shared gate has. */
function checkRuleGates(cfg: ConfigShape, r: Rule, issue: Issue) {
  const noDiff = r.deliver === 'plan' || r.deliver === 'report'
  const shared = [cfg.gates, ...Object.values(cfg.repos).map((p) => p.gates)]
  for (const [name, g] of Object.entries(r.gates ?? {})) {
    if (g.changed && noDiff)
      issue(
        ['gates', name, 'changed'],
        `a ${r.deliver} has no diff: changed needs commits, on a rule that opens a PR or pushes, or in a top-level or repo gate`,
      )
    if (shared.some((gates) => Object.hasOwn(gates, name)))
      issue(
        ['gates', name],
        `a top-level or repo gate is named ${name} too: name this one otherwise`,
      )
  }
}

/** A plan's tasks: a rule to take them, a deliver that finishes them, and a branch that stays put. */
function checkTasks(cfg: ConfigShape, r: Rule, issue: Issue) {
  const takers = cfg.queue?.filter(
    (q) => 'planned' in q.where && (!q.source || !r.source || q.source === r.source),
  )
  if (r.deliver === 'plan' && !takers?.length)
    issue(
      ['deliver'],
      "plan's tasks need a rule to take them: add one whose where names planned, e.g. { skill: implement, where: { planned: true } }",
    )
  const taskDelivers = ['draft_pr', 'pr', 'report']
  if ('planned' in r.where && r.deliver && !taskDelivers.includes(r.deliver))
    issue(
      ['deliver'],
      `a plan's task opens its own PR, or reports on the card, and that's how awaywork knows it's done: deliver draft_pr, pr or report, not ${r.deliver}`,
    )
  if (r.deliver === 'plan' && r.on_done?.comment)
    issue(
      ['on_done', 'comment'],
      "the plan comment is a plan rule's result, so a second comment would repeat it: use move alone",
    )
  // A task's PR is found by its branch, so the branch must stay put when a re-plan retitles the task.
  const templates = r.branch
    ? [r.branch]
    : [cfg.branch, ...Object.values(cfg.repos).flatMap((p) => p.branch ?? [])]
  const moving = 'planned' in r.where && templates.find((t) => /\{(title|type)\}/.test(t))
  if (moving)
    issue(
      ['branch'],
      `a plan's task keeps its PR by its branch, which ${moving} renders from the task's title or skill too: set branch on this rule from {key} alone, e.g. away/{key}`,
    )
  const taskBranches = new Set(
    cfg.queue
      ?.filter((q) => 'planned' in q.where && (!q.source || !r.source || q.source === r.source))
      .map((q) => q.branch),
  )
  if ('planned' in r.where && taskBranches.size > 1)
    issue(
      ['branch'],
      'a re-plan may hand a task another skill, and so another planned rule, which must find its PR on the same branch: set the same branch on every planned rule for its source, or on none',
    )
}
