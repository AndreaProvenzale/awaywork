import type { Config } from '../config/schema.js'
import {
  type Attempts,
  failedAttempts,
  MAX_ATTEMPTS,
  pushedOnto,
  unchangedSince,
} from './attempts.js'
import { isValidRef, renderBranch } from './branch.js'
import { type Allowance, quotaFacts, route } from './budget.js'
import { holds } from './condition.js'
import { dedupe } from './dedupe.js'
import {
  closestRule,
  defaultRules,
  describeComparison,
  failedIn,
  fieldValue,
  isAwayworkPr,
  isLoop,
  isMatch,
  rank,
} from './queue.js'
import { type Origin, resolveSkill, type SkillCatalog } from './skills.js'
import { describeSkip, type Skip } from './skips.js'
import type { Condition, Item, Loop, Rule, Step, Unit, Where, WhereValue } from './types.js'

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
  /** The `then` step left out after this unit, and why: e.g. `then review: over the cap: …`. */
  capped?: string
  loop?: LoopRound
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

export interface RunPlan {
  queue: Rule[]
  defaultQueue: boolean
  units: PlannedUnit[]
  skipped: { item: Item; reason: string }[]
  allowances: Record<string, Allowance>
}

/** Match, dedupe and route this run's items; no I/O. */
export function planRun(input: {
  config: Config
  items: Item[]
  allowances: Record<string, Allowance>
  skills: SkillCatalog
  skips?: Record<string, Skip>
  /** Earlier attempts: a unit none of whose items changed since its skill last finished, or failed 3 times, is skipped. */
  attempts?: Attempts
}): RunPlan {
  const { config, allowances, skips = {} } = input
  const queue = config.queue ?? defaultRules(Object.keys(config.sources))
  const { ranked, unmatched } = rank(input.items, queue)
  const skipped = unmatched.map((item) => ({ item, reason: noRuleReason(item, queue) }))
  const units: PlannedUnit[] = []
  const routed: Record<string, number> = {}
  const sure: Record<string, number> = {}
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
    const skip = (reason: string) => skipped.push(...items.map((item) => ({ item, reason })))
    const skippedByUser = items
      .map((item) => `${item.source}:${item.key}`)
      .find((key) => skips[key])
    if (skippedByUser) {
      skip(describeSkip(skippedByUser, skips[skippedByUser] as Skip))
      continue
    }
    const prs = items.flatMap((i) => i.linkedPrs)
    if (ours && !pickup) {
      skip(`waiting for review: awaywork PR ${ours.url} is open`)
      continue
    }
    const held = pushedOnto(items, input.attempts ?? {})
    if (held) {
      skip(`waiting for review: awaywork pushed onto ${held.url}`)
      continue
    }
    const since = items.map((item) => unchangedSince(item, rule.skill, input.attempts ?? {}))
    if (since.every(Boolean)) {
      skip(`unchanged since run ${since.sort().at(-1)}`)
      continue
    }
    if (items.every((i) => failedAttempts(i, rule.skill, input.attempts ?? {}) >= MAX_ATTEMPTS)) {
      skip(`gave up after ${MAX_ATTEMPTS} attempts; waiting for the item to change`)
      continue
    }
    // The rule's deliver sets its own step's, and a report commits nothing anywhere in the chain.
    const reports = (step: Step) =>
      step === rule && rule.deliver
        ? rule.deliver === 'report'
        : rule.deliver === 'report' ||
          resolveSkill(step.skill, input.skills)?.meta.deliver === 'report'
    const commits = (entry: Step | Loop) => stepsOf(entry).some((s) => !reports(s))
    const chain = [rule, ...(rule.then ?? [])]
    const deliver = rule.deliver === 'push' ? 'push' : 'draft_pr'
    const pr = (chain.some(commits) ? prs.find((p) => p.mine) : undefined) ?? prs[0]
    const repo = pr?.repo ?? items.map((i) => i.fields.repo).find((r) => typeof r === 'string')
    if (!repo) {
      skip('no repo: no linked PR or repo field')
      continue
    }
    const add = (
      step: Step,
      at: Pick<Unit, 'id' | 'base' | 'foreign' | 'untrusted' | 'fork' | 'branch'>,
      chain?: string,
      loop?: LoopRound,
    ) => {
      const skill = resolveSkill(step.skill, input.skills)
      const providers = step.provider.length > 0 ? step.provider : config.providers.map((p) => p.id)
      // Every round is routed, as the run does, so the plan holds fallback units for all of them.
      const { provider, passed } = route(providers, allowances, routed)
      if (provider) routed[provider] = (routed[provider] ?? 0) + 1
      // Caps count what can run when every loop ends after round 1, since the run routes again.
      const runnable =
        loop && loop.round > 1 ? undefined : route(providers, allowances, sure).provider
      if (runnable) sure[runnable] = (sure[runnable] ?? 0) + 1
      // A loop counts once against the caps.
      if (runnable && (!loop || (loop.round === 1 && loop.step === 0))) {
        counted++
        perRepo[repo] = (perRepo[repo] ?? 0) + 1
        perRule[ruleIndex] = (perRule[ruleIndex] ?? 0) + 1
      }
      const repoInstructions = config.repos[repo]?.instructions
      const unit: Unit = {
        ...at,
        network: rule.network ?? config.repos[repo]?.network ?? true,
        verify: rule.verify ?? config.repos[repo]?.verify,
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
        deliver: reports(step) ? 'report' : deliver,
      }
      const unmet = provider && quotaUnmet(step.when, allowances[provider])
      units.push({
        unit,
        rule: ruleIndex,
        itemRules: group.map((e) => e.rule),
        origin: skill?.origin,
        provider,
        passed,
        ...(unmet && { quotaUnmet: unmet }),
        chain,
        ...(loop && { loop }),
      })
      return unit
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

    const template = rule.branch ?? config.repos[repo]?.branch ?? config.branch
    const branch = renderBranch(template, items[0] as Item)
    if (!isValidRef(branch)) {
      skip(`branch template ${template} renders an invalid name "${branch}"`)
      continue
    }
    const base = pr?.branch ?? ''
    const foreign = pr ? !pr.mine : false
    const fork = pr?.fork ? { number: pr.number, head: pr.head } : undefined
    // Steps up to the first that commits run anywhere; from it on, the chain needs a base it may publish onto.
    const first = chain.findIndex(commits)
    const refused = first >= 0 ? deliveryRefusal(deliver, base, foreign, !!fork) : undefined
    if (refused && first === 0) {
      skip(refused)
      continue
    }
    const capped = overCap()
    if (capped) {
      skip(capped)
      continue
    }
    const id = slug(items[0]?.key ?? '')
    const at = { base, foreign, untrusted: pr ? !pr.trusted : false, fork, branch }
    add(rule, { id, ...at })
    for (const [j, entry] of (rule.then ?? []).entries()) {
      const left = (j + 1 >= first ? refused : undefined) || overCap()
      if (left) {
        const last = units.findLast((u) => !u.loop || u.loop.round === 1) as PlannedUnit
        last.capped = `then ${isLoop(entry) ? 'loop' : entry.skill}: ${left}`
        break
      }
      if (!isLoop(entry)) {
        add(entry, { id: `${id}-${slug(entry.skill)}`, ...at }, id)
        continue
      }
      const skills = entry.loop.map((s) => s.skill)
      for (let round = 1; round <= entry.max; round++)
        for (const [s, step] of entry.loop.entries())
          add(step, { id: `${id}-${slug(step.skill)}-${round}`, ...at }, id, {
            at: j,
            round,
            step: s,
            skills,
            until: entry.until,
            max: entry.max,
          })
    }
  }
  return { queue, defaultQueue: !config.queue, units, skipped, allowances }
}

function quotaOf(when: Condition | undefined): Condition | undefined {
  const { runs_until_reset, headroom } = when ?? {}
  if (runs_until_reset === undefined && headroom === undefined) return undefined
  return {
    ...(runs_until_reset !== undefined && { runs_until_reset }),
    ...(headroom !== undefined && { headroom }),
  }
}

function quotaUnmet(when: Condition | undefined, a: Allowance | undefined): string | undefined {
  const quota = quotaOf(when)
  if (!quota || !a) return undefined
  if (a.kind === 'fallback') return 'no quota reading'
  return holds(quota, quotaFacts(a)) ? undefined : "the quota part doesn't hold on the probe"
}

function stepsOf(entry: Step | Loop): Step[] {
  return isLoop(entry) ? entry.loop : [entry]
}

/** Why a chain can't publish commits onto its base: only onto the developer's own PR in the repo. */
function deliveryRefusal(
  deliver: 'draft_pr' | 'push',
  base: string,
  foreign: boolean,
  fork: boolean,
): string | undefined {
  if (deliver === 'push' && !base) return 'deliver push: no PR of yours to push onto'
  if (foreign) return `deliver ${deliver}: ${base} is someone else's PR`
  if (fork) return `deliver ${deliver}: ${base} is on a fork`
}

/** E.g. `matched no rule; closest #2 fix-ci: checks is passing, wants failing`. */
function noRuleReason(item: Item, queue: Rule[]): string {
  const closest = closestRule(item, queue)
  const why = isAwayworkPr(item)
    ? `waiting for review: awaywork PR ${item.url} is open`
    : 'matched no rule'
  if (!closest) return why
  const rule = queue[closest.rule] as Rule
  const failed = describeFailed(rule.where, item, closest.failed)
  return `${why}; closest #${closest.rule + 1} ${rule.skill}: ${failed.join('; ')}`
}

function describeFailed(where: Where, item: Item, keys: string[]): string[] {
  return keys.map((key) => {
    if (key === 'any') {
      const entries = (where[key] as Where[]).map((w) =>
        describeFailed(w, item, failedIn(w, item)).join(', '),
      )
      return `none of any matched: (${entries.join(') (')})`
    }
    const want = where[key] as WhereValue
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

export function slug(key: string): string {
  return key
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
}
