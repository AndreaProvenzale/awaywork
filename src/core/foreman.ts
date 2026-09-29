import type { Config } from '../config/schema.js'
import { type Attempts, unchangedSince } from './attempts.js'
import { isValidRef, renderBranch } from './branch.js'
import { type Allowance, route } from './budget.js'
import { dedupe } from './dedupe.js'
import { closestRule, defaultRules, describeComparison, fieldValue, rank } from './queue.js'
import { type Origin, resolveSkill, type SkillCatalog } from './skills.js'
import type { Item, Rule, Step, Unit, WhereValue } from './types.js'

export interface PlannedUnit {
  unit: Unit
  rule: number
  itemRules: number[]
  origin?: Origin
  provider?: string
  passed: string[]
  /** The unit this one chains after, by id: it runs only on what that unit delivered. */
  after?: string
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
  /** Earlier attempts: a unit none of whose items changed since its skill last ran is skipped. */
  attempts?: Attempts
}): NightPlan {
  const { config, allowances } = input
  const queue = config.queue ?? defaultRules(Object.keys(config.sources))
  const { ranked, unmatched } = rank(input.items, queue)
  const skipped = unmatched.map((item) => ({ item, reason: noRuleReason(item, queue) }))
  const units: PlannedUnit[] = []
  const routed: Record<string, number> = {}

  for (const group of dedupe(ranked)) {
    const items = group.map((e) => e.item)
    const ruleIndex = group[0]?.rule ?? 0
    const rule = queue[ruleIndex] as Rule
    const skip = (reason: string) => skipped.push(...items.map((item) => ({ item, reason })))
    const prs = items.flatMap((i) => i.linkedPrs)
    const ours = prs.find((p) => p.ours)
    if (ours) {
      skip(`waiting for review: night-shift PR ${ours.url} is open`)
      continue
    }
    const since = items.map((item) => unchangedSince(item, rule.skill, input.attempts ?? {}))
    if (since.every(Boolean)) {
      skip(`unchanged since run ${since.sort().at(-1)}`)
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
      at: Pick<Unit, 'id' | 'base' | 'foreign' | 'branch'>,
      after?: string,
    ) => {
      const skill = resolveSkill(step.skill, input.skills)
      const providers = step.provider.length > 0 ? step.provider : config.providers.map((p) => p.id)
      const { provider, passed } = route(providers, allowances, routed)
      if (provider) routed[provider] = (routed[provider] ?? 0) + 1
      const repoInstructions = config.repos[repo]?.instructions
      const unit: Unit = {
        ...at,
        items,
        repo,
        rule: step,
        skill: step.skill,
        skills: step.skills,
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
      })
      return unit
    }

    const chain = [rule, ...(rule.then ?? [])]
    const pushed: string[] = []
    const branches = chain.map((step) => {
      const rendered = renderBranch(templateFor(step), items[0] as Item)
      const branch = pushed.includes(rendered) ? `${rendered}-${step.skill}` : rendered
      if (deliverOf(step) === 'draft_pr') pushed.push(branch)
      return branch
    })
    const bad = branches.findIndex((b) => !isValidRef(b))
    if (bad >= 0) {
      const step = chain[bad] as Step
      const where = bad > 0 ? `then ${step.skill}: ` : ''
      skip(
        `${where}branch template ${templateFor(step)} renders an invalid name "${branches[bad]}"`,
      )
      continue
    }
    const id = slug(items[0]?.key ?? '')
    let previous = add(rule, {
      id,
      base: pr?.branch ?? '',
      foreign: pr ? !pr.mine : false,
      branch: branches[0] as string,
    })
    for (const [j, step] of (rule.then ?? []).entries()) {
      const stacked = previous.deliver === 'draft_pr'
      previous = add(
        step,
        {
          id: `${id}-${slug(step.skill)}`,
          base: stacked ? previous.branch : previous.base,
          foreign: previous.foreign,
          branch: branches[j + 1] as string,
        },
        previous.id,
      )
    }
  }
  return { queue, defaultQueue: !config.queue, units, skipped, allowances }
}

/** E.g. `matched no rule; closest #2 fix-ci: checks is passing, wants failing`. */
function noRuleReason(item: Item, queue: Rule[]): string {
  const closest = closestRule(item, queue)
  if (!closest) return 'matched no rule'
  const rule = queue[closest.rule] as Rule
  const failed = closest.failed.map((key) => {
    const want = rule.where[key] as WhereValue
    return `${key} is ${describeValue(fieldValue(item, key))}, wants ${describeWant(want)}`
  })
  return `matched no rule; closest #${closest.rule + 1} ${rule.skill}: ${failed.join('; ')}`
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
