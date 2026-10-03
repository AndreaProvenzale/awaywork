import { styleText } from 'node:util'
import { type Allowance, pct } from '../core/budget.js'
import { describeCondition } from '../core/condition.js'
import type { NightPlan } from '../core/foreman.js'
import { bounds, comparisons, isAge, isLoop, isMatch, spans } from '../core/queue.js'
import type { Rule, Where, WhereValue } from '../core/types.js'

/** The plan and warnings as JSON; items drop their raw source payload. */
export function planJson(plan: NightPlan, warnings: string[] = []): string {
  return JSON.stringify(
    { ...plan, warnings },
    (key, value) => (key === 'raw' ? undefined : value),
    2,
  )
}

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
  // A loop's later rounds repeat its first: only round 1 is listed.
  const units = plan.units.filter((p) => !p.loop || p.loop.round === 1)
  if (units.length === 0) out.push('  none')
  else {
    const rows = units.map((p, i) => [
      String(i + 1),
      p.unit.id,
      p.unit.repo,
      `#${p.rule + 1}`,
      `${p.unit.skill} (${p.origin === 'builtin' ? 'built-in' : (p.origin ?? 'in-repo?')})`,
      p.provider ?? '-',
      // A push loop's rounds commit for its push, not for a draft PR.
      p.loop?.deliver === 'push' && p.unit.deliver === 'draft_pr' ? 'push' : p.unit.deliver,
      p.unit.deliver === 'push' || p.loop?.deliver === 'push' ? p.unit.base : p.unit.branch,
    ])
    const header = ['', 'unit', 'repo', 'rule', 'skill', 'provider', 'deliver', 'branch']
    const lines = table([header, ...rows])
    out.push(`  ${style('bold', lines[0] ?? '')}`)
    units.forEach((p, i) => {
      out.push(`  ${lines[i + 1]}`)
      if (p.after) out.push(`     after ${p.after}`)
      if (p.unit.rule.when) out.push(`     when ${describeCondition(p.unit.rule.when)}`)
      if (p.loop?.step === 0) {
        const { skills, until, max, host, deliver } = p.loop
        const publish = deliver === 'push' ? `one push onto ${p.unit.base}` : 'one draft PR'
        out.push(
          `     loop ${skills.join(' ⇄ ')} until ${describeCondition(until)}, at most ${max} ${max === 1 ? 'round' : 'rounds'}; ${publish} from ${host}`,
        )
      }
      const [top, ...merged] = p.unit.items
      out.push(`     ${top?.source} ${top?.key}: ${top?.title}`)
      merged.forEach((item, j) => {
        const rule = p.itemRules[j + 1] ?? p.rule
        out.push(`     + ${item.source} ${item.key}: same feature, matched #${rule + 1}`)
      })
      if (p.capped) out.push(`     ${p.capped}`)
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
  const where = describeConditions(r.where)
  const extras = [
    r.provider.length > 0 && `provider=${r.provider.join('|')}`,
    r.model &&
      `model=${Object.entries(r.model)
        .map(([p, m]) => `${p}:${m}`)
        .join('|')}`,
    r.deliver && `deliver=${r.deliver}`,
    r.order && `order=${r.order}`,
    r.then?.length &&
      `then=${r.then.map((s) => (isLoop(s) ? `loop(${s.loop.map((l) => l.skill).join(',')})` : s.skill)).join(',')}`,
  ]
  return (
    [r.source && `source=${r.source}`, ...where, ...extras].filter(Boolean).join(' ') ||
    'every item'
  )
}

function describeConditions(where: Where): string[] {
  return Object.entries(where).map(([k, v]) =>
    k === 'any'
      ? `any(${(v as Where[]).map((w) => describeConditions(w).join(' ')).join(' | ')})`
      : describeWhere(k, v as WhereValue),
  )
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

/** The markdown morning report for a terminal: pipe tables aligned, statuses styled. */
export function formatReportForTerminal(markdown: string): string {
  const lines = markdown.split('\n')
  const out: string[] = []
  for (let i = 0; i < lines.length; ) {
    const rows: string[][] = []
    for (let line = lines[i]; line?.startsWith('|'); line = lines[++i])
      if (!/^\|[-| ]+\|$/.test(line))
        rows.push(
          line
            .slice(2, -2)
            .split(' | ')
            .map((cell) => cell.replaceAll('\\|', '|')),
        )
    if (rows.length === 0) out.push(lines[i++] ?? '')
    else {
      const statusCol = rows[0]?.indexOf('Status') ?? -1
      out.push(
        ...table(rows, (cell, r, c) =>
          r > 0 && c === statusCol ? styleText(statusStyle(cell), cell) : cell,
        ),
      )
    }
  }
  return out.join('\n')
}

function statusStyle(status: string): 'green' | 'red' | 'yellow' | 'dim' {
  if (status.startsWith('done')) return 'green'
  if (status.startsWith('failed') || status.startsWith('error')) return 'red'
  if (status.startsWith('stopped')) return 'yellow'
  return 'dim'
}

function table(
  rows: string[][],
  style: (cell: string, r: number, c: number) => string = (cell) => cell,
): string[] {
  const widths = rows[0]?.map((_, c) => Math.max(...rows.map((r) => r[c]?.length ?? 0))) ?? []
  return rows.map((row, r) =>
    row
      .map((cell, c) => style(cell.padEnd(widths[c] ?? 0), r, c))
      .join('  ')
      .trimEnd(),
  )
}

export type Status = 'ok' | 'warn' | 'FAIL'

const markers = { ok: ['✔', 'green'], warn: ['⚠', 'yellow'], FAIL: ['✖', 'red'] } as const

/** A colored glyph for a terminal, the plain word everywhere else. */
export function statusMarker(status: Status, color: boolean): string {
  if (!color) return status.padEnd(4)
  const [glyph, style] = markers[status]
  return styleText(style, glyph, { validateStream: false })
}
