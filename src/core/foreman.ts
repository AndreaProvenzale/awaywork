import type { Config } from '../config/schema.js'
import { type Attempts, gaveUpUntil, MAX_ATTEMPTS, pushedOnto, unchangedSince } from './attempts.js'
import { isValidRef } from './branch.js'
import { type Allowance, quotaFacts, route } from './budget.js'
import { holds } from './condition.js'
import { dedupe } from './dedupe.js'
import { branchName, committingStep, expandPlans, stepReports } from './fanout.js'
import { awaitsAnswer } from './footer.js'
import { globToRegExp } from './glob.js'
import { plannedSkills, planState } from './plan.js'
import {
  closestRule,
  defaultRules,
  describeComparison,
  failedIn,
  fieldValue,
  implicitWhere,
  isAwayworkPr,
  isLoop,
  isMatch,
  rank,
  TOP,
  within,
} from './queue.js'
import { type Origin, resolveSkill, type SkillCatalog } from './skills.js'
import { describeSkip, type Skip } from './skips.js'
import type {
  Condition,
  Deliver,
  Gate,
  Item,
  Loop,
  Rule,
  Step,
  ThenStep,
  Unit,
  Where,
  WhereValue,
} from './types.js'

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
  /** The chain's slice this step is in, counted from 0; unset in the first. */
  slice?: number
  loop?: LoopRound
  /** On a chain's first step: the slice a cap left out, and the cap. */
  capped?: string
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
  | 'invalid_plan'
  | 'fanned_out'
  | 'waiting_for_task'
  | 'task_merged'
  | 'all_tasks_merged'
  | 'gave_up'
  | 'no_repo'
  | 'invalid_branch'
  | 'refused_delivery'
  | 'unstackable'

/** Whether you can act to make the item run: the rest is the config working as intended. */
export const needsYou: Record<SkipKind, boolean> = {
  no_rule: false,
  skipped_by_you: false,
  unchanged: false,
  over_cap: false,
  waiting_for_review: true,
  waiting_for_answer: true,
  waiting_for_approval: true,
  invalid_plan: true,
  fanned_out: false,
  waiting_for_task: false,
  task_merged: false,
  all_tasks_merged: true,
  gave_up: true,
  no_repo: true,
  invalid_branch: true,
  refused_delivery: true,
  unstackable: true,
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
  defaultQueue: boolean
  units: PlannedUnit[]
  skipped: Skipped[]
  allowances: Record<string, Allowance>
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
  /** Plans only the units of a repo glob and a 1-based rule, under the full run's caps. */
  only?: { repo?: string; rule?: number }
}): RunPlan {
  const { config, allowances, skips = {}, now = Date.now(), only = {} } = input
  const onlyRepo = only.repo === undefined ? undefined : globToRegExp(only.repo)
  const queue = config.queue ?? defaultRules(Object.keys(config.sources))
  const expanded = expandPlans(input.items, config, queue)
  const { ranked, unmatched } = rank(expanded.items, queue)
  const skipped: Skipped[] = [
    ...expanded.skipped,
    ...unmatched.map((item) => ({ item, ...noRuleReason(item, queue) })),
  ]
  const units: PlannedUnit[] = []
  const routed: Record<string, number> = {}
  const perRepo: Record<string, number> = {}
  const perRule: Record<number, number> = {}
  let counted = 0

  for (const found of dedupe(ranked)) {
    const ours = found.flatMap((e) => e.item.linkedPrs).find((p) => p.ours)
    // An awaywork PR taken by a rule leads its feature: that rule decides, its key names the unit.
    const pickup = ours && found.find((e) => isAwayworkPr(e.item))
    const group = pickup ? [pickup, ...found.filter((e) => e !== pickup)] : found
    const items = group.map((e) => e.item)
    const ruleIndex = group[0]?.rule ?? 0
    const rule = queue[ruleIndex] as Rule
    if (only.rule !== undefined && ruleIndex + 1 !== only.rule) continue
    const skip = (kind: SkipKind, reason: string, url?: string) =>
      skipped.push(...items.map((item) => ({ item, kind, reason, ...(url && { url }) })))
    const skippedByUser = items
      .map((item) => `${item.source}:${item.key}`)
      .find((key) => skips[key])
    if (skippedByUser) {
      skip('skipped_by_you', describeSkip(skippedByUser, skips[skippedByUser] as Skip))
      continue
    }
    const prs = items.flatMap((i) => i.linkedPrs)
    if (ours && !pickup) {
      skip('waiting_for_review', `waiting for review: awaywork PR ${ours.url} is open`, ours.url)
      continue
    }
    const held = pushedOnto(items, input.attempts ?? {})
    if (held) {
      skip(
        'waiting_for_review',
        `waiting for review: awaywork pushed onto your PR ${held.url}`,
        held.url,
      )
      continue
    }
    // Read off the item, not attempts, so a runner without state waits too, and awaywork's comment doesn't count as a change; a task's questions wait on its card.
    const asked = items.find((i) => !i.task && awaitsAnswer(i))
    if (asked) {
      skip('waiting_for_answer', `waiting for your answer on ${asked.url}`, asked.url)
      continue
    }
    // Every step of a plan rule reports, so its repo is the first linked PR's or the item's.
    const limits = (item: Item) => ({
      maxTasks: config.limits.plan_tasks,
      repo: prs[0]?.repo ?? items.map((i) => i.fields.repo).find((r) => typeof r === 'string'),
      skills: plannedSkills(queue, item.source),
    })
    const card =
      rule.deliver === 'plan'
        ? items.flatMap((item) => {
            const state = planState(item, limits(item))
            return state ? [{ item, ...state }] : []
          })[0]
        : undefined
    if (card?.state === 'waiting') {
      skip(
        'waiting_for_approval',
        `waiting for your approval of the plan on ${card.item.url}`,
        card.item.url,
      )
      continue
    }
    if (card?.state === 'invalid') {
      skip('invalid_plan', `plan refused: ${card.problem}`, card.item.url)
      continue
    }
    const since = items.map((item) => unchangedSince(item, rule.skill, input.attempts ?? {}))
    if (since.every(Boolean)) {
      skip('unchanged', `unchanged since run ${since.sort().at(-1)}`)
      continue
    }
    const retries = items.map((i) => gaveUpUntil(i, rule.skill, input.attempts ?? {}, now))
    if (retries.every(Boolean)) {
      const next = Math.min(...retries.map(Number))
      skip(
        'gave_up',
        `gave up after ${MAX_ATTEMPTS} attempts; next try on ${new Date(next).toLocaleDateString('sv-SE')}`,
      )
      continue
    }
    // A skill commits unless it reports; `deliver: report`, `pending_review` and `plan` make every step report.
    const review = rule.deliver === 'pending_review'
    const planned = rule.deliver === 'plan'
    const reports = stepReports(rule, input.skills)
    const committing = committingStep(rule, input.skills)
    const deliver = rule.deliver === 'push' || rule.deliver === 'pr' ? rule.deliver : 'draft_pr'
    const pr = (committing ? prs.find((p) => p.mine) : undefined) ?? prs[0]
    const repo = pr?.repo ?? items.map((i) => i.fields.repo).find((r) => typeof r === 'string')
    if (!repo) {
      skip('no_repo', 'no repo: no linked PR or repo field')
      continue
    }
    if (onlyRepo && !onlyRepo.test(repo)) continue
    if (review && !pr) {
      skip('refused_delivery', 'deliver pending_review: no pull request to review')
      continue
    }
    const template = rule.branch ?? config.repos[repo]?.branch ?? config.branch
    // A slice's name takes the type of its first committing step; the list's words keep it a valid ref.
    const branchOf = (step: ThenStep | undefined) =>
      branchName(config, rule, repo, items[0] as Item, step, input.skills)
    const branch = branchOf(committing)
    if (!isValidRef(branch)) {
      skip('invalid_branch', `branch template ${template} renders an invalid name "${branch}"`)
      continue
    }
    const base = pr?.branch ?? ''
    const foreign = pr ? !pr.mine : false
    const fork = pr?.fork ? { number: pr.number, head: pr.head } : undefined
    const refused = committing && deliveryRefusal(deliver, base, foreign, !!fork)
    if (refused) {
      skip(
        'refused_delivery',
        committing === rule ? refused : `${refused}, and ${committing.skill} commits`,
      )
      continue
    }
    const unstackable = stackRefusal(rule, reports)
    if (unstackable) {
      skip('unstackable', unstackable)
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
    if (capped) {
      skip('over_cap', capped)
      continue
    }

    const id = slug(items[0]?.key ?? '')
    const at = { base, foreign, untrusted: pr ? !pr.trusted : false, fork, branch }
    let slice = 0
    const add = (written: ThenStep, unitId: string, loop?: LoopRound) => {
      const step = written === rule ? rule : inherit(rule, written)
      const skill = resolveSkill(step.skill, input.skills)
      const providers = step.provider.length > 0 ? step.provider : config.providers.map((p) => p.id)
      // Every step is routed, as the run does, so the plan holds fallback units for all of them.
      const { provider, passed } = route(providers, allowances, routed)
      if (provider) routed[provider] = (routed[provider] ?? 0) + 1
      const repoInstructions = config.repos[repo]?.instructions
      const unit: Unit = {
        ...at,
        id: unitId,
        verify: config.repos[repo]?.verify,
        gates: gatesFor(config, repo),
        items,
        repo,
        rule: step,
        skill: step.skill,
        skills: [...config.skills, ...step.skills],
        providers,
        instructions: [
          ...config.instructions,
          ...(repoInstructions ? [repoInstructions] : []),
          ...step.instructions,
        ],
        deliver: review ? 'pending_review' : planned ? 'plan' : reports(step) ? 'report' : deliver,
      }
      const unmet = provider && written === rule && quotaUnmet(rule.when, allowances[provider])
      units.push({
        unit,
        rule: ruleIndex,
        itemRules: group.map((e) => e.rule),
        origin: skill?.origin,
        provider,
        passed,
        ...(unmet && { quotaUnmet: unmet }),
        ...(written !== rule && { chain: id }),
        ...(slice > 0 && { slice }),
        ...(loop && { loop }),
      })
      return provider
    }
    // A slice publishes once, so it counts once, when its first step routes.
    const count = (routed: string | undefined) => {
      if (!routed) return
      counted++
      perRepo[repo] = (perRepo[repo] ?? 0) + 1
      perRule[ruleIndex] = (perRule[ruleIndex] ?? 0) + 1
    }
    count(add(rule, id))
    for (const [j, entry] of (rule.then ?? []).entries()) {
      if (entry.stack) {
        const left = overCap()
        if (left) {
          const head = units.find((u) => u.unit.id === id) as PlannedUnit
          head.capped = `stack ${isLoop(entry) ? 'loop' : entry.skill}: ${left}`
          break
        }
        slice++
        at.branch = branchOf(stepsOf(entry)[0])
      }
      if (!isLoop(entry)) {
        const routed = add(entry, `${id}-${slug(entry.skill)}`)
        if (entry.stack) count(routed)
        continue
      }
      const skills = entry.loop.map((s) => s.skill)
      for (let round = 1; round <= entry.max; round++)
        for (const [s, step] of entry.loop.entries()) {
          const routed = add(step, `${id}-${slug(step.skill)}-${round}`, {
            at: j,
            round,
            step: s,
            skills,
            until: entry.until,
            max: entry.max,
          })
          if (entry.stack && round === 1 && s === 0) count(routed)
        }
    }
  }
  return { queue, defaultQueue: !config.queue, units, skipped, allowances }
}

/** The top-level gates with the repo's: a repo adds gates, and on a shared name its globs, command and skill join the top-level ones. */
function gatesFor(config: Config, repo: string): Record<string, Gate> | undefined {
  const gates = new Map<string, Gate>()
  for (const [name, g] of [
    ...Object.entries(config.gates),
    ...Object.entries(config.repos[repo]?.gates ?? {}),
  ]) {
    const gate = gates.get(name) ?? { changed: [], commands: [], skills: [] }
    gate.changed.push(...(g.changed ?? []))
    if (g.command) gate.commands.push(g.command)
    if (g.skill) gate.skills.push(g.skill)
    gates.set(name, gate)
  }
  return gates.size ? Object.fromEntries(gates) : undefined
}

function quotaUnmet(when: Condition | undefined, a: Allowance | undefined): string | undefined {
  if (!when || !a) return undefined
  if (a.kind === 'fallback') return 'no quota reading'
  return holds(when, quotaFacts(a)) ? undefined : "doesn't hold on the probe"
}

function stepsOf(entry: ThenStep | Loop): ThenStep[] {
  return isLoop(entry) ? entry.loop : [entry]
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

/** Why a `stack` can't start a slice: its first step reports, or every step before it does. */
function stackRefusal(rule: Rule, reports: (step: ThenStep) => boolean): string | undefined {
  const steps: ThenStep[] = [rule]
  for (const entry of rule.then ?? []) {
    const first = stepsOf(entry)[0] as ThenStep
    if (entry.stack && reports(first))
      return `stack on ${first.skill}: it reports, so its PR would have nothing in it`
    if (entry.stack && steps.every(reports))
      return `stack on ${first.skill}: every step before it reports, so there is nothing to stack on`
    steps.push(...stepsOf(entry))
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

/** E.g. `matched no rule; closest #2 fix: checks is passing, wants failing`. */
function noRuleReason(item: Item, queue: Rule[]): Omit<Skipped, 'item'> {
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

/** E.g. `implement → loop(review ⇄ fix) → stack docs`. */
export function describeChain(chain: PlannedUnit[]): string {
  return chain
    .filter((p) => !p.loop || (p.loop.round === 1 && p.loop.step === 0))
    .map((p, i, listed) => {
      const step = p.loop ? `loop(${p.loop.skills.join(' ⇄ ')})` : p.unit.skill
      return i > 0 && p.slice !== listed[i - 1]?.slice ? `stack ${step}` : step
    })
    .join(' → ')
}

/** A chain's steps, or their results, grouped by slice in order. */
export function bySlice<T>(steps: T[], sliceOf: (step: T) => number | undefined): T[][] {
  const slices: T[][] = []
  for (const step of steps) {
    const at = sliceOf(step) ?? 0
    slices[at] = [...(slices[at] ?? []), step]
  }
  return slices.filter(Boolean)
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

/** Whether `name` is the item's key, `source:key` or short ref, in any case, and nothing looser. */
export const isNamed = (item: Item, name: string) =>
  [item.key, `${item.source}:${item.key}`, shortRef(item)].some(
    (n) => n.toLowerCase() === name.toLowerCase(),
  )
