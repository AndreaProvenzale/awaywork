import type { Config } from '#config/schema'
import { resolveSkill, type SkillCatalog } from '#core/skills'
import type { Condition, Gate, Item, PrRef, Rule, Step, TaskPr, ThenStep, Unit } from '#core/types'
import type { DraftLeft } from '#posts/footer'
import { type Allowance, quotaFacts, route } from '#quota/budget'
import { branchName, planLimits, stepReports } from '#tasks/fanout'
import type { PlanState } from '#tasks/plan-file'
import { holds } from './condition'
import type { LoopRound, PlannedUnit } from './foreman'
import { settingsFor } from './repos'

/** Where a chain lands: its repo and PR, the branch it publishes on and the base under it. */
export interface Landing {
  repo: string
  pr?: PrRef
  /** The rule's first step that commits, if one does. */
  committing?: ThenStep
  /** How its committing steps publish. */
  deliver: 'push' | 'pr' | 'draft_pr'
  branch: string
  base: string
  foreign: boolean
  fork?: { number: number; head?: string }
  /** A merging skill named otherwise than the built-in, which the config can't check. */
  merging?: boolean
  stackedOn?: string
}

export function landing(chain: {
  config: Config
  rule: Rule
  skills: SkillCatalog
  items: Item[]
  repo: string
  pr?: PrRef
  committing?: ThenStep
  /** The open PR of the task it stacks on. */
  onto?: TaskPr
  draft?: DraftLeft
}): Landing {
  const { rule, items, pr, draft } = chain
  const base = pr?.branch ?? chain.onto?.branch ?? ''
  // A resumed task's draft stays stacked on the task below it while that one is open.
  const below = draft && items[0]?.task?.onto && items[0].task.parent.taskPrs?.[items[0].task.onto]
  const stackedOn = chain.onto?.url ?? (below && below.state === 'open' ? below.url : undefined)
  return {
    repo: chain.repo,
    pr,
    committing: chain.committing,
    deliver: rule.deliver === 'push' || rule.deliver === 'pr' ? rule.deliver : 'draft_pr',
    // A chain's name takes the type of its first committing step; the list's words keep it a valid ref.
    branch: branchName(
      chain.config,
      rule,
      chain.repo,
      items[0] as Item,
      chain.committing,
      chain.skills,
    ),
    base,
    foreign: pr ? !pr.mine : false,
    fork: pr?.fork ? { number: pr.number, head: pr.head } : undefined,
    merging: resolveSkill(rule.skill, chain.skills)?.meta.merge,
    stackedOn,
  }
}

/** The units of a rule's chain on the group, its first step first, each routed to a provider; `counts` when the first one runs. */
export function chainUnits(
  run: {
    config: Config
    queue: Rule[]
    skills: SkillCatalog
    allowances: Record<string, Allowance>
  },
  routed: Record<string, number>,
  chain: {
    rule: Rule
    ruleIndex: number
    itemRules: number[]
    items: Item[]
    id: string
    steps: { written: ThenStep; id: string; loop?: LoopRound }[]
    oneOff: boolean
    at: Landing
    draft?: DraftLeft
    left?: { continued: number }
    card?: PlanState
    posted?: { answer: string }
    after?: PlannedUnit
    waitsFor: string[]
  },
): { units: PlannedUnit[]; counts: boolean } {
  const { config, allowances } = run
  const { rule, items, oneOff, draft, left } = chain
  const { repo, pr, base, merging } = chain.at
  // A skill commits unless it reports; `deliver: report`, `pending_review` and `plan` make every step report.
  const review = rule.deliver === 'pending_review'
  const planned = rule.deliver === 'plan'
  const reports = stepReports(rule, run.skills)
  // A post after your feedback, or a task's PR closed, waits for you whatever `wait` says.
  const again =
    chain.card?.state === 'feedback' ||
    chain.card?.state === 'replan' ||
    chain.posted?.answer === 'feedback'
  // A report that neither waits nor has gates of its own posts as a plain result, `wait: false` too.
  const decides = planned || (rule.deliver === 'report' && (rule.wait === true || !!rule.gates))
  const waits = decides ? again || (rule.wait ?? planned) : undefined
  // Only a post reads the step's summary: a report rule posts when it decides or comments its result.
  const lean =
    (decides || (rule.deliver === 'report' && rule.on_done?.comment === 'result')) &&
    !items[0]?.task &&
    (rule.post ?? (config.store ? 'summary' : 'full')) === 'summary'
  const at = {
    base,
    foreign: chain.at.foreign,
    untrusted: pr ? !pr.trusted : false,
    fork: chain.at.fork,
    ...(merging && { merge: pr?.into }),
    branch: draft ? base : chain.at.branch,
    ...(chain.at.stackedOn && { stackedOn: chain.at.stackedOn }),
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
  const settings = settingsFor(config.repos, repo)
  const units: PlannedUnit[] = []
  for (const { written, id, loop } of [{ written: rule, id: chain.id }, ...chain.steps]) {
    const step = written === rule ? rule : inherit(rule, written)
    const skill = resolveSkill(step.skill, run.skills)
    const providers = step.provider.length > 0 ? step.provider : config.providers.map((p) => p.id)
    // Every step is routed, as the run does, so the plan holds fallback units for all of them; a merge takes a provider only to resolve conflicts the source read.
    const routes = !at.merge || items.some((i) => i.fields.conflicts === true)
    // A one-off runs alone, so the rule units planned before it take no fallback unit from it.
    const { provider, passed } = routes
      ? route(providers, allowances, oneOff ? {} : routed)
      : { passed: [] }
    if (provider) routed[provider] = (routed[provider] ?? 0) + 1
    const unit: Unit = {
      ...at,
      id,
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
      deliver: review
        ? 'pending_review'
        : planned
          ? 'plan'
          : reports(step)
            ? 'report'
            : chain.at.deliver,
      ...(planned && { planLimits: planLimits(config, run.queue, items[0] as Item, run.skills) }),
    }
    const unmet = provider && written === rule && quotaUnmet(rule.quota, allowances[provider])
    units.push({
      unit,
      rule: chain.ruleIndex,
      itemRules: chain.itemRules,
      origin: skill?.origin,
      provider,
      passed,
      ...(unmet && { quotaUnmet: unmet }),
      ...(written !== rule && { chain: chain.id }),
      ...(loop && { loop }),
      ...(written === rule && chain.after && { after: chain.after.unit.id }),
      ...(written === rule && chain.waitsFor.length > 0 && { waitsFor: chain.waitsFor }),
    })
  }
  // A chain publishes once, so it counts once, when its first step runs.
  return { units, counts: !!units[0]?.provider || !!at.merge }
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
