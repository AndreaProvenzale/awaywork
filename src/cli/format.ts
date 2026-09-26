import { type Allowance, pct } from '../core/budget.js'
import type { NightPlan } from '../core/foreman.js'
import type { Rule, WhereValue } from '../core/types.js'

/** The plan and warnings as JSON; items drop their raw source payload. */
export function planJson(plan: NightPlan, warnings: string[] = []): string {
  return JSON.stringify(
    { ...plan, warnings },
    (key, value) => (key === 'raw' ? undefined : value),
    2,
  )
}

/** The plan as text: every unit names its rule, skill origin and why it got its provider. */
export function formatPlan(plan: NightPlan, warnings: string[] = []): string {
  const out: string[] = []
  if (warnings.length > 0) out.push('Warnings', ...warnings.map((w) => `  ${w}`), '')

  out.push(plan.defaultQueue ? 'Queue (default: no queue in config)' : 'Queue')
  const rules = plan.queue.map((r, i) => [`#${i + 1}`, r.skill, describeRule(r)])
  out.push(...indent(table(rules)))

  out.push('', 'Providers')
  const ceilings = Object.entries(plan.allowances).map(([id, a]) => [id, describeAllowance(a)])
  out.push(...indent(table(ceilings)))

  out.push('', 'Units')
  if (plan.units.length === 0) out.push('  none')
  else {
    const rows = plan.units.map((p, i) => [
      String(i + 1),
      p.unit.id,
      p.unit.repo,
      `#${p.rule + 1}`,
      `${p.unit.skill} (${p.origin === 'builtin' ? 'built-in' : (p.origin ?? 'in-repo?')})`,
      p.provider ?? '-',
      p.unit.deliver,
      p.unit.branch,
    ])
    const header = ['', 'unit', 'repo', 'rule', 'skill', 'provider', 'deliver', 'branch']
    const lines = table([header, ...rows])
    out.push(`  ${lines[0]}`)
    plan.units.forEach((p, i) => {
      out.push(`  ${lines[i + 1]}`)
      const [top, ...merged] = p.unit.items
      out.push(`     ${top?.source} ${top?.key}: ${top?.title}`)
      merged.forEach((item, j) => {
        const rule = p.itemRules[j + 1] ?? p.rule
        out.push(`     + ${item.source} ${item.key}: same feature, matched #${rule + 1}`)
      })
      if (p.passed.length > 0 || !p.provider)
        out.push(
          `     provider: ${[...p.passed, p.provider ? `took ${p.provider}` : 'none left'].join('; ')}`,
        )
    })
  }

  if (plan.skipped.length > 0) {
    out.push('', 'Skipped')
    for (const s of plan.skipped) out.push(`  ${s.item.source} ${s.item.key}: ${s.reason}`)
  }
  return out.join('\n')
}

export function describeRule(r: Rule): string {
  const where = Object.entries(r.where).map(([k, v]) => describeWhere(k, v))
  const extras = [
    r.provider.length > 0 && `provider=${r.provider.join('|')}`,
    r.deliver && `deliver=${r.deliver}`,
    r.order && `order=${r.order}`,
  ]
  return (
    [r.source && `source=${r.source}`, ...where, ...extras].filter(Boolean).join(' ') ||
    'every item'
  )
}

function describeWhere(key: string, value: WhereValue): string {
  if (typeof value === 'object' && !Array.isArray(value))
    return `${key}!=${[value.not].flat().join('|')}`
  return `${key}=${[value].flat().join('|')}`
}

export function describeAllowance(a: Allowance): string {
  if (a.kind === 'fallback')
    return `fallback: ${a.units} units, ${a.turns} turns each (${a.reason})`
  const binding = a.limits.find((l) => l.value === a.ceiling)?.name
  const others = a.limits
    .filter((l) => l.name !== binding)
    .map((l) => `${l.name} ${pct(l.value)}`)
    .join(', ')
  const session = a.session
    ? `; session ${pct(a.session.used)}, workers stop at ${pct(a.session.stopAt)}`
    : ''
  const nights = `${a.nights} night${a.nights === 1 ? '' : 's'} to reset`
  return `${a.window} ${pct(a.used)} used, ceiling ${pct(a.ceiling)} set by ${binding} (${others}; ${nights})${session}`
}

function indent(lines: string[]): string[] {
  return lines.map((l) => `  ${l}`)
}

function table(rows: string[][]): string[] {
  const widths = rows[0]?.map((_, c) => Math.max(...rows.map((r) => r[c]?.length ?? 0))) ?? []
  return rows.map((r) =>
    r
      .map((cell, c) => cell.padEnd(widths[c] ?? 0))
      .join('  ')
      .trimEnd(),
  )
}
