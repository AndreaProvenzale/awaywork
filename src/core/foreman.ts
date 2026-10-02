import type { Config } from '../config/schema.js'
import { type Attempts, failedAttempts, MAX_ATTEMPTS, unchangedSince } from './attempts.js'
import { isValidRef, renderBranch } from './branch.js'
import { type Allowance, route } from './budget.js'
import { dedupe } from './dedupe.js'
import {
  closestRule,
  defaultRules,
  describeComparison,
  fieldValue,
  isLoop,
  isNightShiftPr,
  rank,
} from './queue.js'
import { type Origin, resolveSkill, type SkillCatalog } from './skills.js'
import { describeSkip, type Skip } from './skips.js'
import type { Condition, Item, Loop, Rule, Step, Unit, WhereValue } from './types.js'

export interface PlannedUnit {
  unit: Unit
  rule: number
  itemRules: number[]
  origin?: Origin
  provider?: string
  passed: string[]
  /** The unit this one chains after, by id: it runs only on what that unit delivered. */
  after?: string
  /** The `then` step left out after this unit, and why: e.g. `then review: over the cap: …`. */
  capped?: string
  /** A loop round: it works in the host unit's clone, which publishes once the loop ends. */
  loop?: LoopRound
}

export interface LoopRound {
  host: string
  round: number
  /** The step's index in the loop. */
  step: number
  skills: string[]
  until: Condition
  max: number
}

export interface NightPlan {
  queue: Rule[]
  defaultQueue: boolean
  units: PlannedUnit[]
  skipped: { item: Item; reason: string }[]
  allowances: Record<string, Allowance>
}

/** Match, dedupe and route tonight's items; no I/O. */
export function planNight(input: {
  config: Config
  items: Item[]
  allowances: Record<string, Allowance>
  skills: SkillCatalog
  skips?: Record<string, Skip>
  /** Earlier attempts: a unit none of whose items changed since its skill last finished, or failed 3 times, is skipped. */
  attempts?: Attempts
}): NightPlan {
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
    // A night-shift PR taken by a rule leads its feature: that rule decides, its key names the unit.
    const pickup = ours && found.find((e) => isNightShiftPr(e.item))
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
      skip(`waiting for review: night-shift PR ${ours.url} is open`)
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
    const pr = prs[0]
    const repo = pr?.repo ?? items.map((i) => i.fields.repo).find((r) => typeof r === 'string')
    if (!repo) {
      skip('no repo: no linked PR or repo field')
      continue
    }
    const templateFor = (step: Step) => step.branch ?? config.repos[repo]?.branch ?? config.branch
    const deliverOf = (step: Step) =>
      step.deliver ?? resolveSkill(step.skill, input.skills)?.meta.deliver ?? 'draft_pr'
    const add = (
      step: Step,
      at: Pick<Unit, 'id' | 'base' | 'foreign' | 'untrusted' | 'branch'>,
      after?: string,
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
        deliver: deliverOf(step),
      }
      units.push({
        unit,
        rule: ruleIndex,
        itemRules: group.map((e) => e.rule),
        origin: skill?.origin,
        provider,
        passed,
        after,
        ...(loop && { loop }),
      })
      return unit
    }
    const overCap = () => {
      const cap = [
        { name: 'night.units', max: config.night.units, count: counted },
        {
          name: 'night.units_per_repo',
          max: config.night.units_per_repo,
          count: perRepo[repo] ?? 0,
        },
        { name: `rule #${ruleIndex + 1} units`, max: rule.units, count: perRule[ruleIndex] ?? 0 },
      ].find((c) => c.max !== undefined && c.count >= c.max)
      return cap && `over the cap: ${cap.name} is ${cap.max}`
    }

    const chain = [rule, ...(rule.then ?? [])]
    const pushed: string[] = []
    let delivers: Unit['deliver'] | undefined
    const branches = chain.map((entry) => {
      // A loop after a draft PR works on that unit's branch.
      if (isLoop(entry) && delivers === 'draft_pr') return undefined
      const step = firstStep(entry)
      const rendered = renderBranch(templateFor(step), items[0] as Item)
      const branch = pushed.includes(rendered) ? `${rendered}-${step.skill}` : rendered
      delivers = isLoop(entry) ? 'draft_pr' : deliverOf(step)
      if (delivers === 'draft_pr') pushed.push(branch)
      return branch
    })
    const bad = branches.findIndex((b) => b !== undefined && !isValidRef(b))
    if (bad >= 0) {
      const step = firstStep(chain[bad] as Step | Loop)
      const where = bad > 0 ? `then ${step.skill}: ` : ''
      skip(
        `${where}branch template ${templateFor(step)} renders an invalid name "${branches[bad]}"`,
      )
      continue
    }
    const capped = overCap()
    if (capped) {
      skip(capped)
      continue
    }
    const id = slug(items[0]?.key ?? '')
    /** Plans every round; the host is the draft PR unit before, else the loop's first unit on a fresh clone. */
    const addLoop = (loop: Loop, before: Unit, branch: string | undefined): Unit => {
      let host = branch === undefined ? before : undefined
      const skills = loop.loop.map((s) => s.skill)
      for (let round = 1; round <= loop.max; round++)
        for (const [s, step] of loop.loop.entries()) {
          const on = host ?? before
          const unit = add(
            step,
            {
              id: `${id}-${slug(step.skill)}-${round}`,
              base: host ? host.base : before.base,
              foreign: on.foreign,
              untrusted: on.untrusted,
              branch: host ? host.branch : (branch as string),
            },
            host ? undefined : before.id,
            {
              host: host?.id ?? `${id}-${slug(step.skill)}-1`,
              round,
              step: s,
              skills,
              until: loop.until,
              max: loop.max,
            },
          )
          host ??= unit
        }
      return { ...(host as Unit), deliver: 'draft_pr' }
    }
    let previous = add(rule, {
      id,
      base: pr?.branch ?? '',
      foreign: pr ? !pr.mine : false,
      untrusted: pr ? !pr.trusted : false,
      branch: branches[0] as string,
    })
    for (const [j, entry] of (rule.then ?? []).entries()) {
      const capped = overCap()
      if (capped) {
        const last = units.find((u) => u.unit.id === previous.id) as PlannedUnit
        last.capped = `then ${isLoop(entry) ? 'loop' : entry.skill}: ${capped}`
        break
      }
      if (isLoop(entry)) {
        previous = addLoop(entry, previous, branches[j + 1])
        continue
      }
      const stacked = previous.deliver === 'draft_pr'
      previous = add(
        entry,
        {
          id: `${id}-${slug(entry.skill)}`,
          base: stacked ? previous.branch : previous.base,
          foreign: previous.foreign,
          untrusted: previous.untrusted,
          branch: branches[j + 1] as string,
        },
        previous.id,
      )
    }
  }
  return { queue, defaultQueue: !config.queue, units, skipped, allowances }
}

function firstStep(entry: Step | Loop): Step {
  return isLoop(entry) ? (entry.loop[0] as Step) : entry
}

/** E.g. `matched no rule; closest #2 fix-ci: checks is passing, wants failing`. */
function noRuleReason(item: Item, queue: Rule[]): string {
  const closest = closestRule(item, queue)
  const why = isNightShiftPr(item)
    ? `waiting for review: night-shift PR ${item.url} is open`
    : 'matched no rule'
  if (!closest) return why
  const rule = queue[closest.rule] as Rule
  const failed = closest.failed.map((key) => {
    const want = rule.where[key] as WhereValue
    return `${key} is ${describeValue(fieldValue(item, key))}, wants ${describeWant(want)}`
  })
  return `${why}; closest #${closest.rule + 1} ${rule.skill}: ${failed.join('; ')}`
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
