import { styleText } from 'node:util'
import { type Allowance, pct } from '../core/budget.js'
import { describeCondition } from '../core/condition.js'
import type { PlannedUnit, RunPlan } from '../core/foreman.js'
import { bounds, comparisons, isAge, isLoop, isMatch, ruleMatches, spans } from '../core/queue.js'
import type { Item, Rule, Where, WhereValue } from '../core/types.js'

/** The plan and warnings as JSON; items drop their raw source payload. */
export function planJson(plan: RunPlan, warnings: string[] = []): string {
  return JSON.stringify(
    { ...plan, warnings },
    (key, value) => (key === 'raw' ? undefined : value),
    2,
  )
}

/** One per chain: its first step stands for it. */
export function listedUnits(plan: RunPlan) {
  return plan.units.filter((p) => !p.chain)
}

/** A `Warnings` heading over indented warnings and a blank line, or nothing. */
export function warningLines(warnings: string[], styled = false): string[] {
  if (warnings.length === 0) return []
  const heading = styled ? styleText('bold', 'Warnings') : 'Warnings'
  return [heading, ...warnings.map((w) => `  ${w}`), '']
}

/** The plan as text: every unit names its rule, skill origin and why it got its provider. */
export function formatPlan(plan: RunPlan, warnings: string[] = [], styled = false): string {
  const style = (format: 'bold' | 'dim', text: string) => (styled ? styleText(format, text) : text)
  const out = warningLines(warnings, styled)

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
  const units = listedUnits(plan)
  if (units.length === 0) out.push('  none')
  else {
    const stepsOf = (head: PlannedUnit) => plan.units.filter((p) => p.chain === head.unit.id)
    const rows = units.map((p, i) => {
      const deliver = [p, ...stepsOf(p)].find((s) => s.unit.deliver !== 'report')?.unit.deliver
      return [
        String(i + 1),
        p.unit.id,
        p.unit.repo,
        `#${p.rule + 1}`,
        describeSkill(p),
        p.provider ?? '-',
        deliver ?? 'report',
        deliver === 'push' ? p.unit.base : p.unit.branch,
      ]
    })
    const header = ['', 'unit', 'repo', 'rule', 'skill', 'provider', 'deliver', 'branch']
    const lines = table([header, ...rows])
    out.push(`  ${style('bold', lines[0] ?? '')}`)
    units.forEach((p, i) => {
      out.push(`  ${lines[i + 1]}`)
      const unmet = p.quotaUnmet ? ` (${p.quotaUnmet})` : ''
      if (p.unit.rule.when) out.push(`     when ${describeCondition(p.unit.rule.when)}${unmet}`)
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
      // A loop's later rounds repeat its first: only round 1 is listed.
      let slice = 0
      for (const s of stepsOf(p).filter((s) => !s.loop || s.loop.round === 1)) {
        // A stacked slice starts with `stack` where the others say `then`.
        const then = (s.slice ?? 0) !== slice ? 'stack' : 'then'
        slice = s.slice ?? 0
        if (s.loop?.step === 0) {
          const { skills, until, max } = s.loop
          out.push(
            `     ${then} loop ${skills.join(' ⇄ ')} until ${describeCondition(until)}, at most ${max} ${max === 1 ? 'round' : 'rounds'}`,
          )
        }
        const when = s.unit.rule.when ? `, when ${describeCondition(s.unit.rule.when)}` : ''
        const passed = s.passed.length > 0 ? ` (${s.passed.join('; ')})` : ''
        const on = `on ${s.provider ?? 'no provider left'}${passed}`
        out.push(`     ${s.loop ? '  ' : `${then} `}${describeSkill(s)} ${on}${when}`)
      }
      if (p.capped) out.push(`     ${p.capped}`)
    })
  }

  if (plan.skipped.length > 0) {
    out.push('', style('bold', 'Skipped'))
    for (const s of plan.skipped) out.push(`  ${s.item.source} ${s.item.key}: ${s.reason}`)
  }
  return out.join('\n')
}

/** What each rule takes now and what earlier rules take from it, then the unmatched items. */
export function formatRules(rules: Rule[], items: Item[]): string[] {
  const matches = ruleMatches(items, rules)
  const keys = (list: Item[]) =>
    list.length === 0
      ? ''
      : `: ${list
          .slice(0, 3)
          .map((i) => i.key)
          .join(', ')}${list.length > 3 ? ', …' : ''}`
  const width = Math.max(...rules.map((r) => r.skill.length))
  const lines = rules.flatMap((rule, i) => {
    const { taken, shadowed } = matches[i] ?? { taken: [], shadowed: [] }
    const block = [`#${i + 1}  ${rule.skill.padEnd(width)}  ${describeRule(rule)}`]
    block.push(`     ${taken.length} taken${keys(taken)}`)
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

function describeSkill(p: PlannedUnit): string {
  return `${p.unit.skill} (${p.origin === 'builtin' ? 'built-in' : (p.origin ?? 'in-repo?')})`
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
    r.order && `order=${r.order}`,
    r.then?.length &&
      `then=${r.then.map((s) => `${s.stack ? 'stack:' : ''}${isLoop(s) ? `loop(${s.loop.map((l) => l.skill).join(',')})` : s.skill}`).join(',')}`,
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

export function describeAllowance(a: Allowance): string {
  if (a.kind === 'fallback') return `fallback: ${describeFallback(a)}`
  const session = a.session
    ? `; session ${pct(a.session.used)}, workers stop at ${pct(a.session.stopAt)}`
    : ''
  return `${a.window} ${pct(a.used)} used, ceiling ${pct(a.ceiling)} set by ${bindingLimit(a)} (${otherLimits(a)}; resets in ${runs(a.runs)})${session}`
}

type QuotaAllowance = Extract<Allowance, { kind: 'quota' }>
type FallbackAllowance = Extract<Allowance, { kind: 'fallback' }>

function allowanceRow(id: string, a: Allowance): string[] {
  if (a.kind === 'fallback') return [id, 'fallback']
  const session = a.session ? `${pct(a.session.used)} / ${pct(a.session.stopAt)}` : '-'
  return [id, a.window, pct(a.used), pct(a.ceiling), bindingLimit(a), runs(a.runs), session]
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

const runs = (n: number) => `${n} run${n === 1 ? '' : 's'}`

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

const amber = (text: string) => `\u001b[38;2;247;178;64m${text}\u001b[39m`

/** The logo as a line: a crescent with an amber prompt in it, then the tagline. */
export function brandHeader(color: boolean): string {
  const tagline = "You're away, your agents work"
  if (!color) return `☾ >_ awaywork  ${tagline}`
  const style = (format: 'bold' | 'dim', text: string) =>
    styleText(format, text, { validateStream: false })
  return `☾ ${style('bold', amber('>_'))} ${style('bold', 'awaywork')}  ${style('dim', tagline)}`
}
