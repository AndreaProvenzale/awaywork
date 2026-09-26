import { styleText } from 'node:util'
import { type Allowance, pct } from '../core/budget.js'
import type { NightPlan } from '../core/foreman.js'
import type { Rule, WhereValue } from '../core/types.js'

/** The plan as text: every unit names its rule, skill origin and why it got its provider. */
export function formatPlan(plan: NightPlan, warnings: string[] = [], styled = false): string {
  const style = (format: 'bold' | 'dim', text: string) => (styled ? styleText(format, text) : text)
  const out: string[] = []
  if (warnings.length > 0) out.push(style('bold', 'Warnings'), ...warnings.map((w) => `  ${w}`), '')

  out.push(style('bold', plan.defaultQueue ? 'Queue (default: no queue in config)' : 'Queue'))
  const rules = plan.queue.map((r, i) => [`#${i + 1}`, r.skill, describeRule(r)])
  out.push(...indent(table(rules)))

  out.push('', style('bold', 'Providers'))
  const allowances = Object.entries(plan.allowances)
  const providerHeader = [
    'provider',
    'window',
    'used',
    'ceiling',
    'set by',
    'resets in',
    'session / stop at',
  ]
  const providerLines = table([providerHeader, ...allowances.map(([id, a]) => allowanceRow(id, a))])
  out.push(`  ${style('bold', providerLines[0] ?? '')}`)
  allowances.forEach(([, a], i) => {
    out.push(`  ${providerLines[i + 1]}`)
    out.push(style('dim', `    ${allowanceNote(a)}`))
  })

  out.push('', style('bold', 'Units'))
  if (plan.units.length === 0) out.push('  none')
  else {
    const rows = plan.units.map((p, i) => [
      String(i + 1),
      p.unit.id,
      p.unit.repo,
      `#${p.rule + 1}`,
      `${p.unit.skill} (${p.origin ?? 'in-repo?'})`,
      p.provider ?? '-',
      p.unit.deliver,
      p.unit.branch,
    ])
    const header = ['', 'unit', 'repo', 'rule', 'skill', 'provider', 'deliver', 'branch']
    const lines = table([header, ...rows])
    out.push(`  ${style('bold', lines[0] ?? '')}`)
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
    out.push('', style('bold', 'Skipped'))
    for (const s of plan.skipped) out.push(`  ${s.item.source} ${s.item.key}: ${s.reason}`)
  }
  return out.join('\n')
}

export function describeRule(r: Rule): string {
  const where = Object.entries(r.where).map(([k, v]) => describeWhere(k, v))
  const extras = [
    r.provider.length > 0 && `provider=${r.provider.join('|')}`,
    r.deliver && `deliver=${r.deliver}`,
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
  if (a.kind === 'fallback') return `fallback: ${describeFallback(a)}`
  const session = a.session
    ? `; session ${pct(a.session.used)}, workers stop at ${pct(a.session.stopAt)}`
    : ''
  return `${a.window} ${pct(a.used)} used, ceiling ${pct(a.ceiling)} set by ${bindingLimit(a)} (${otherLimits(a)}; resets in ${nights(a.nights)})${session}`
}

type QuotaAllowance = Extract<Allowance, { kind: 'quota' }>
type FallbackAllowance = Extract<Allowance, { kind: 'fallback' }>

function allowanceRow(id: string, a: Allowance): string[] {
  if (a.kind === 'fallback') return [id, 'fallback']
  const session = a.session ? `${pct(a.session.used)} / ${pct(a.session.stopAt)}` : '-'
  return [id, a.window, pct(a.used), pct(a.ceiling), bindingLimit(a), nights(a.nights), session]
}

function allowanceNote(a: Allowance): string {
  return a.kind === 'fallback' ? describeFallback(a) : `other limits: ${otherLimits(a)}`
}

function describeFallback(a: FallbackAllowance): string {
  return `${a.units} units, ${a.turns} turns each (${a.reason})`
}

// `reserve` is the share kept back; its limit is the cap that leaves it.
const limitName = (name: string) => (name === 'reserve' ? 'reserve cap' : name)

const binding = (a: QuotaAllowance) => a.limits.find((l) => l.value === a.ceiling)

const bindingLimit = (a: QuotaAllowance) => limitName(binding(a)?.name ?? '-')

function otherLimits(a: QuotaAllowance): string {
  return a.limits
    .filter((l) => l !== binding(a))
    .map((l) => `${limitName(l.name)} ${pct(l.value)}`)
    .join(', ')
}

const nights = (n: number) => `${n} night${n === 1 ? '' : 's'}`

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
