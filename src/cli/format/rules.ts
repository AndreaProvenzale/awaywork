import type { Item, Rule, Where, WhereValue } from '../../core/types.js'
import { noRuleReason, type RunPlan } from '../../plan/foreman.js'
import { isLoop, matches as matchesRule, ruleMatches } from '../../plan/queue.js'
import { bounds, comparisons, isAge, isMatch, spans } from '../../plan/where.js'
import { itemRef } from './json.js'
import { indent, table } from './terminal.js'

export const NO_QUEUE =
  'Nothing will run: the config has no queue; /away or awaywork init writes one'

/** The queue as numbered rules. */
export function queueLines(plan: Pick<RunPlan, 'queue'>): string[] {
  if (plan.queue.length === 0) return [NO_QUEUE]
  const rules = plan.queue.map((r, i) => [`#${i + 1}`, r.skill, describeRule(r)])
  return ['Queue', ...indent(table(rules))]
}

/** `plan --rules`: the queue under its heading, or that the config has none. */
export function formatQueue(rules: Rule[], items: Item[]): string[] {
  if (rules.length === 0) return [NO_QUEUE]
  return ['Queue', ...indent(formatRules(rules, items))]
}

/** What each rule takes now and what other rules take from it, then the unmatched items. */
export function formatRules(rules: Rule[], items: Item[]): string[] {
  const matches = ruleMatches(items, rules)
  const keys = (list: Item[], rule?: Rule) =>
    list.length === 0
      ? ''
      : `: ${list
          .slice(0, 3)
          .map((i) => (rule && !matchesRule(rule, i) ? `${i.key} (plan)` : i.key))
          .join(', ')}${list.length > 3 ? ', …' : ''}`
  const width = Math.max(...rules.map((r) => r.skill.length))
  const lines = rules.flatMap((rule, i) => {
    const { taken, shadowed } = matches[i] ?? { taken: [], shadowed: [] }
    const block = [`#${i + 1}  ${rule.skill.padEnd(width)}  ${describeRule(rule)}`]
    block.push(`     ${taken.length} taken${keys(taken, rule)}`)
    for (const by of new Set(shadowed.map((s) => s.by))) {
      const list = shadowed.filter((s) => s.by === by).map((s) => s.item)
      block.push(`     ${list.length} taken by #${by + 1}${keys(list)}`)
    }
    return block
  })
  const matched = new Set(matches.flatMap((m) => m.taken))
  const unmatched = items.filter((i) => !matched.has(i))
  return [...lines, `${unmatched.length} unmatched${keys(unmatched)}`]
}

/** `formatRules` as JSON, every item listed, each unmatched one with why it misses its closest rule; `plan` marks a card its `deliver: plan` rule holds though its `where` no longer matches. */
export function rulesJson(rules: Rule[], items: Item[], warnings: string[] = []): string {
  const matches = ruleMatches(items, rules)
  const matched = new Set(matches.flatMap((m) => m.taken))
  const described = rules.map((rule, i) => {
    const { taken, shadowed } = matches[i] ?? { taken: [], shadowed: [] }
    const takenBy = [...new Set(shadowed.map((s) => s.by))].map((by) => ({
      rule: by + 1,
      items: shadowed.filter((s) => s.by === by).map((s) => itemRef(s.item)),
    }))
    return {
      rule: i + 1,
      skill: rule.skill,
      summary: describeRule(rule),
      taken: taken.map((item) =>
        matchesRule(rule, item) ? itemRef(item) : { ...itemRef(item), plan: true },
      ),
      takenBy,
    }
  })
  const unmatched = items
    .filter((i) => !matched.has(i))
    .map((item) => ({ ...itemRef(item), reason: noRuleReason(item, rules).reason }))
  return JSON.stringify({ rules: described, unmatched, warnings }, null, 2)
}

export function describeRule(r: Rule): string {
  const where = describeConditions(r.where)
  const extras = [
    r.provider.length > 0 && `provider=${r.provider.join('|')}`,
    r.model &&
      `model=${Object.entries(r.model)
        .map(([p, m]) => `${p}:${[m].flat().join('>')}`)
        .join('|')}`,
    r.deliver && `deliver=${r.deliver}`,
    r.wait !== undefined && `wait=${r.wait}`,
    r.gates && `gates=${Object.keys(r.gates).join(',')}`,
    r.order && `order=${r.order}`,
    r.run === 'soon' && 'run=soon',
    r.then?.length &&
      `then=${r.then.map((s) => (isLoop(s) ? `loop(${s.loop.map((l) => l.skill).join(',')})` : s.skill)).join(',')}`,
  ]
  return (
    [r.source && `source=${r.source}`, ...where, ...extras].filter(Boolean).join(' ') ||
    'every item'
  )
}

function describeConditions({ any, ...where }: Where): string[] {
  const conditions = Object.entries(where).map(([k, v]) => describeWhere(k, v as WhereValue))
  if (any)
    conditions.push(
      `any(${(any as Where[]).map((w) => describeConditions(w).join(' ')).join(' | ')})`,
    )
  return conditions
}

function describeWhere(key: string, value: WhereValue): string {
  if (typeof value === 'object' && !Array.isArray(value)) {
    if ('not' in value) return `${key}!=${[value.not].flat().join('|')}`
    if (isMatch(value)) return `${key}~/${value.matches}/i`
    if (isAge(value))
      return spans(value)
        .map(([op, span]) => `${key}:${op}=${span}`)
        .join(' ')
    return bounds(value)
      .map(([op, bound]) => `${key}${comparisons[op].symbol}${bound}`)
      .join(' ')
  }
  return `${key}=${[value].flat().join('|')}`
}
