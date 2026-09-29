import type { Config } from '../config/schema.js'
import { type Attempts, failedAttempts, MAX_ATTEMPTS } from './attempts.js'
import { isValidRef, renderBranch } from './branch.js'
import { type Allowance, route } from './budget.js'
import { dedupe } from './dedupe.js'
import { closestRule, defaultRules, describeComparison, fieldValue, rank } from './queue.js'
import { type Origin, resolveSkill, type SkillCatalog } from './skills.js'
import type { Item, Rule, Unit, WhereValue } from './types.js'

export interface PlannedUnit {
  unit: Unit
  rule: number
  itemRules: number[]
  origin?: Origin
  provider?: string
  passed: string[]
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
    if (items.every((i) => failedAttempts(input.attempts ?? {}, i) >= MAX_ATTEMPTS)) {
      skip(`gave up after ${MAX_ATTEMPTS} attempts; waiting for the item to change`)
      continue
    }
    const pr = prs[0]
    const repo = pr?.repo ?? items.map((i) => i.fields.repo).find((r) => typeof r === 'string')
    if (!repo) {
      skip('no repo: no linked PR or repo field')
      continue
    }
    const template = rule.branch ?? config.repos[repo]?.branch ?? config.branch
    const branch = renderBranch(template, items[0] as Item)
    if (!isValidRef(branch)) {
      skip(`branch template ${template} renders an invalid name "${branch}"`)
      continue
    }
    const skill = resolveSkill(rule.skill, input.skills)
    const providers = rule.provider.length > 0 ? rule.provider : config.providers.map((p) => p.id)
    const { provider, passed } = route(providers, allowances, routed)
    if (provider) routed[provider] = (routed[provider] ?? 0) + 1
    const id = slug(items[0]?.key ?? '')
    const repoInstructions = config.repos[repo]?.instructions
    units.push({
      unit: {
        id,
        items,
        repo,
        base: pr?.branch ?? '',
        foreign: pr ? !pr.mine : false,
        branch,
        rule,
        skill: rule.skill,
        skills: rule.skills,
        providers,
        instructions: [
          ...config.instructions,
          ...(repoInstructions ? [repoInstructions] : []),
          ...rule.instructions,
        ],
        deliver: rule.deliver ?? skill?.meta.deliver ?? 'draft_pr',
      },
      rule: ruleIndex,
      itemRules: group.map((e) => e.rule),
      origin: skill?.origin,
      provider,
      passed,
    })
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
