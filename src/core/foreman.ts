import type { Config } from '../config/schema.js'
import { type Allowance, route } from './budget.js'
import { dedupe } from './dedupe.js'
import { defaultQueue, rank } from './queue.js'
import { type Origin, resolveSkill, type SkillCatalog } from './skills.js'
import type { Item, Rule, Unit } from './types.js'

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
}): NightPlan {
  const { config, allowances } = input
  const queue = config.queue ?? defaultQueue.filter((r) => r.source && r.source in config.sources)
  const { ranked, unmatched } = rank(input.items, queue)
  const skipped = unmatched.map((item) => ({ item, reason: 'matched no rule' }))
  const units: PlannedUnit[] = []
  const routed: Record<string, number> = {}

  for (const group of dedupe(ranked)) {
    const items = group.map((e) => e.item)
    const ruleIndex = group[0]?.rule ?? 0
    const rule = queue[ruleIndex] as Rule
    const pr = items.flatMap((i) => i.linkedPrs)[0]
    const repo = pr?.repo ?? items.map((i) => i.fields.repo).find((r) => typeof r === 'string')
    if (!repo) {
      skipped.push(
        ...items.map((item) => ({ item, reason: 'no repo: no linked PR or repo field' })),
      )
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
        branch: `night/${id}`,
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

export function slug(key: string): string {
  return key
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
}
