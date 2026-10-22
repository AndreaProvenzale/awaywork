import { styleText } from 'node:util'
import { type Allowance, pct } from '../core/budget.js'
import { describeCondition } from '../core/condition.js'
import {
  isNamed,
  type PlannedUnit,
  type RunPlan,
  type SkipKind,
  shortRef,
} from '../core/foreman.js'
import { bounds, comparisons, isAge, isLoop, isMatch, ruleMatches, spans } from '../core/queue.js'
import {
  byKind,
  type Chain,
  chainCells,
  chains,
  counted,
  localTime,
  needsYouOn,
  quotaLines,
  type ReportedSkip,
  type RunReport,
  runHeadline,
  stepCells,
  type UnitResult,
} from '../core/report.js'
import type { Item, Rule, Where, WhereValue } from '../core/types.js'
import { providers } from '../providers/index.js'

const withoutRaw = (key: string, value: unknown) => (key === 'raw' ? undefined : value)

/** The plan and warnings as JSON; items drop their raw source payload. */
export function planJson(plan: RunPlan, warnings: string[] = []): string {
  return JSON.stringify({ ...plan, warnings }, withoutRaw, 2)
}

const itemRef = ({ source, key, title, url }: Item) => ({ source, key, title, url })
const withItemRefs = (p: PlannedUnit) => ({
  ...p,
  unit: { ...p.unit, items: p.unit.items.map(itemRef) },
})

/** The run's results and warnings as JSON; items keep only what `formatReport` shows of them. */
export function reportJson(report: RunReport, warnings: string[] = []): string {
  const { plan, results } = report
  return JSON.stringify(
    {
      ...report,
      plan: {
        ...plan,
        units: plan.units.map(withItemRefs),
        skipped: plan.skipped.map((s) => ({ ...s, item: itemRef(s.item) })),
      },
      results: results.map((r) => ({ ...r, planned: withItemRefs(r.planned) })),
      warnings,
    },
    null,
    2,
  )
}

/** One per chain: its first step stands for it. */
export function listedUnits(plan: Pick<RunPlan, 'units'>) {
  return plan.units.filter((p) => !p.chain)
}

/** A `Warnings` heading over warnings indented as blocks and a blank line, or nothing. */
export function warningLines(warnings: string[], styled = false): string[] {
  if (warnings.length === 0) return []
  return [
    heading('Warnings', warnings.length, styler(styled)),
    ...warnings.flatMap((w) => indent(warningBlock(w))),
    '',
  ]
}

/** A warning's lines, the later ones indented under the first. */
export function warningBlock(warning: string): string[] {
  return warning
    .split('\n')
    .filter((line) => line.trim())
    .map((line, i) => `${i ? '  ' : ''}${line.trimEnd()}`)
}

export type Style = (format: 'bold' | 'dim', text: string) => string

/** `Units 3`: a section's title and how many it holds. */
export const heading = (title: string, n: number, style: Style = (_, text) => text) =>
  style('bold', `${title} ${n}`)

const styler =
  (styled: boolean): Style =>
  (format, text) =>
    styled ? styleText(format, text) : text

const TITLE = 60

export const clip = (text: string, length: number) =>
  text.length > length ? `${text.slice(0, length - 1).trimEnd()}…` : text

/** The plan as text: providers, units, what needs you and how many items were skipped. */
export function formatPlan(plan: RunPlan, warnings: string[] = [], styled = false): string {
  const style = styler(styled)
  const out = [...warningLines(warnings, styled), ...providerLines(plan, style)]
  out.push('', heading('Units', listedUnits(plan).length, style), ...planUnitLines(plan, style))
  out.push(...needsYouLines(plan.skipped, style), ...skippedLines(plan.skipped, style))
  if (plan.skipped.length > 0)
    out.push(
      '',
      ...hintLines(style, [
        ['awaywork plan --skipped [kind]', 'lists them'],
        ['awaywork plan --why <key>', 'says why an item is planned or not'],
      ]),
    )
  return out.join('\n')
}

/** The default queue's note, then each provider's window, ceiling and session. */
export function providerLines(plan: RunPlan, style: Style = (_, text) => text): string[] {
  const out = plan.defaultQueue
    ? [style('dim', 'Queue: the default, no queue in config; awaywork plan --rules lists it'), '']
    : []
  out.push(style('bold', 'Providers'))
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
  const lines = table([providerHeader, ...allowances.map(([id, a]) => allowanceRow(id, a))])
  out.push(`  ${style('bold', lines[0] ?? '')}`)
  allowances.forEach(([id, a], i) => {
    out.push(`  ${lines[i + 1]}`)
    out.push(style('dim', `    ${allowanceNote(id, a)}`))
  })
  return out
}

const stepsOf = (plan: Pick<RunPlan, 'units'>, head: PlannedUnit) =>
  plan.units.filter((p) => p.chain === head.unit.id)

const deliverOf = (plan: Pick<RunPlan, 'units'>, p: PlannedUnit) =>
  [p, ...stepsOf(plan, p)].find((s) => s.unit.deliver !== 'report')?.unit.deliver ?? 'report'

export function planUnitLines(plan: RunPlan, style: Style = (_, text) => text): string[] {
  const { header, units } = planUnitTable(plan, style)
  return units.length === 0 ? ['  none'] : indent([header, ...units.flat()])
}

/** The units table, unindented: one row per unit with its item, rule, skill, provider, delivery and title, clipped at `clipAt`, then its `when`, merged items and chain. */
export function planUnitTable(
  plan: RunPlan,
  style: Style = (_, text) => text,
  clipAt = TITLE,
): { header: string; units: string[][] } {
  const units = listedUnits(plan)
  const rows = units.map((p, i) => {
    const top = p.unit.items[0]
    return [
      String(i + 1),
      top ? shortRef(top) : p.unit.id,
      `#${p.rule + 1}`,
      describeSkill(p),
      p.provider ?? '-',
      deliverOf(plan, p),
      clip(top?.title ?? '', clipAt),
    ]
  })
  const header = ['', 'item', 'rule', 'skill', 'provider', 'deliver', 'title']
  const lines = table([header, ...rows])
  const blocks = units.map((p, i) => {
    const out = [lines[i + 1] ?? '']
    const unmet = p.quotaUnmet ? ` (${p.quotaUnmet})` : ''
    if (p.unit.rule.when) out.push(`   when ${describeCondition(p.unit.rule.when)}${unmet}`)
    p.unit.items.slice(1).forEach((item, j) => {
      const rule = p.itemRules[j + 1] ?? p.rule
      out.push(`   + ${shortRef(item)}: same feature, matched #${rule + 1}`)
    })
    if (p.passed.length > 0 || !p.provider)
      out.push(
        `   provider: ${[...p.passed, p.provider ? `took ${p.provider}` : 'none left'].join('; ')}`,
      )
    // A loop's later rounds repeat its first: only round 1 is listed.
    let slice = 0
    for (const s of stepsOf(plan, p).filter((s) => !s.loop || s.loop.round === 1)) {
      // A stacked slice starts with `stack` where the others say `then`.
      const then = (s.slice ?? 0) !== slice ? 'stack' : 'then'
      slice = s.slice ?? 0
      if (s.loop?.step === 0) {
        const { skills, until, max } = s.loop
        out.push(
          `   ${then} loop ${skills.join(' ⇄ ')} until ${describeCondition(until)}, at most ${max} ${max === 1 ? 'round' : 'rounds'}`,
        )
      }
      const when = s.unit.rule.when ? `, when ${describeCondition(s.unit.rule.when)}` : ''
      const passed = s.passed.length > 0 ? ` (${s.passed.join('; ')})` : ''
      const on = `on ${s.provider ?? 'no provider left'}${passed}`
      out.push(`   ${s.loop ? '  ' : `${then} `}${describeSkill(s)} ${on}${when}`)
    }
    if (p.capped) out.push(`   ${p.capped}`)
    return out
  })
  return { header: style('bold', lines[0] ?? ''), units: blocks }
}

/** The skipped items you can act on: each one's ref and why, then its title. */
export function needsYouLines(skipped: ReportedSkip[], style: Style = (_, text) => text): string[] {
  const rows = needsYouRows(skipped, style)
  if (rows.length === 0) return []
  return ['', heading('Needs you', rows.length, style), ...indent(rows.flatMap((row) => row.lines))]
}

/** Each skipped item you can act on, with its row of the Needs you table, its reason without the closest rule clipped at `clipAt`, and its title, unindented. */
export function needsYouRows(
  skipped: ReportedSkip[],
  style: Style = (_, text) => text,
  clipAt = CELL,
) {
  const reason = (s: ReportedSkip) => brief(reasonOf(s).replace(/; closest #.*$/, ''), clipAt)
  return itemRows(skipped.filter(needsYouOn), reason, style, clipAt)
}

/** What a reason starts with that its kind already says. */
const kindSays: Partial<Record<SkipKind, RegExp>> = {
  no_rule: /^matched no rule(; |$)/,
  over_cap: /^over the cap: /,
  unchanged: /^unchanged /,
}

/** A row per skipped item, unindented: its ref and why, less what its kind says, then its title. */
export function skippedRows(skipped: ReportedSkip[], style: Style, clipAt: number) {
  const said = (s: ReportedSkip) => (s.kind && kindSays[s.kind]) || ''
  const reason = (s: ReportedSkip) => brief(reasonOf(s).replace(said(s), ''), clipAt)
  return itemRows(skipped, reason, style, clipAt)
}

/** A skip's reason without the URL its row, or `--why`, already shows. */
const reasonOf = (s: ReportedSkip) => s.reason.replace(` ${s.url ?? s.item.url}`, '')

function itemRows<S extends ReportedSkip>(
  skipped: S[],
  text: (s: S) => string,
  style: Style,
  clipAt: number,
): { skipped: S; lines: string[] }[] {
  if (skipped.length === 0) return []
  const lines = table(skipped.map((s) => [shortRef(s.item), text(s)]))
  const under = ' '.repeat(Math.max(...skipped.map((s) => shortRef(s.item).length)) + 2)
  return skipped.map((s, i) => ({
    skipped: s,
    lines: [lines[i] ?? '', style('dim', `${under}${clip(s.item.title, clipAt)}`)],
  }))
}

/** The other skipped items, counted by kind on one line. */
export function skippedLines(skipped: ReportedSkip[], style: Style = (_, text) => text): string[] {
  const rest = skipped.filter((s) => !needsYouOn(s))
  if (rest.length === 0) return []
  return ['', skippedHeading(rest, style)]
}

/** `Skipped 2: 1 no_rule, 1 over_cap`, or `Skipped 2` for skips without kinds. */
export function skippedHeading(skipped: ReportedSkip[], style: Style = (_, text) => text): string {
  const counts = byKind(skipped)?.map(([kind, list]) => `${list.length} ${kind}`)
  const title = heading('Skipped', skipped.length, style)
  return counts ? `${title}: ${counts.join(', ')}` : title
}

const skippedLine = (s: ReportedSkip) => `${shortRef(s.item)}: ${s.reason}`

function hintLines(style: Style, hints: [string, string][]): string[] {
  return table(hints).map((line) => style('dim', line))
}

/** Every skipped item and why, under the counts `plan` shows, or those of one kind. */
export function formatSkipped(skipped: ReportedSkip[], kind?: string): string {
  const line = (s: ReportedSkip) => `  ${skippedLine(s)}`
  if (kind) {
    const list = skipped.filter((s) => s.kind === kind)
    return [`Skipped ${kind} (${list.length})`, ...list.map(line)].join('\n')
  }
  const waiting = skipped.filter(needsYouOn)
  const rest = skipped.filter((s) => !needsYouOn(s))
  const out = waiting.length > 0 ? [`Needs you ${waiting.length}`, ...waiting.map(line)] : []
  if (rest.length > 0) out.push(skippedHeading(rest), ...rest.map(line))
  return out.length > 0 ? out.join('\n') : 'Skipped 0'
}

const itemId = (item: Item) => `${item.source}:${item.key}`

/** The plan's items `name` names by key, `source:key` or ref, each once. */
export function namedItems(plan: RunPlan, name: string): Item[] {
  const all = [...plan.units.flatMap((p) => p.unit.items), ...plan.skipped.map((s) => s.item)]
  const named = all.filter((i) => isNamed(i, name))
  return named.filter((i, k) => named.findIndex((j) => itemId(j) === itemId(i)) === k)
}

/** The refusal of a name that names several: each one by `source:key`, which names one. */
export function ambiguous(name: string, items: Item[]): string {
  const rows = items.map((i) => [itemId(i), clip(i.title, TITLE)])
  return [`"${name}" names ${items.length} items; pick one:`, ...indent(table(rows))].join('\n')
}

/** Why an item is or isn't planned: its unit, or why it was skipped. */
export function formatWhy(plan: RunReport['plan'], named: Item): string {
  const units = listedUnits(plan)
  const out: string[] = []
  const heading = (item: Item) => [`${item.source} ${item.key}  ${item.title}`, `  ${item.url}`]
  const isIt = (item: Item) => itemId(item) === itemId(named)
  units.forEach((p, i) => {
    const item = p.unit.items.find(isIt)
    if (!item) return
    const passed = p.passed.length > 0 ? ` (${p.passed.join('; ')})` : ''
    const rule = plan.queue[p.rule]
    const rows = [
      ['unit', `${i + 1}, ${p.unit.id}`],
      ['rule', `#${p.rule + 1} ${rule ? describeRule(rule) : ''}`],
      ['skill', describeSkill(p)],
      ['provider', `${p.provider ?? 'none left'}${passed}`],
      ['deliver', deliverOf(plan, p)],
      ['branch', deliverOf(plan, p) === 'push' ? p.unit.base : p.unit.branch],
    ]
    out.push(
      ...(out.length ? [''] : []),
      ...heading(item),
      '  planned',
      ...indent(indent(table(rows))),
    )
  })
  for (const s of plan.skipped.filter((s) => isIt(s.item))) {
    out.push(
      ...(out.length ? [''] : []),
      ...heading(s.item),
      `  skipped${s.kind ? `: ${s.kind}` : ''}`,
    )
    const waits = s.url && s.url !== s.item.url ? [`    waits on ${s.url}`] : []
    out.push(`    ${reasonOf(s)}`, ...waits)
    // The closest rule is named by its number.
    if (s.kind === 'no_rule') out.push('', ...queueLines(plan))
  }
  return out.join('\n')
}

/** The queue as numbered rules. */
export function queueLines(plan: Pick<RunPlan, 'queue' | 'defaultQueue'>): string[] {
  const rules = plan.queue.map((r, i) => [`#${i + 1}`, r.skill, describeRule(r)])
  return [
    plan.defaultQueue ? 'Queue (default: no queue in config)' : 'Queue',
    ...indent(table(rules)),
  ]
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

export function describeAllowance(id: string, a: Allowance): string {
  if (a.kind === 'fallback') return `fallback: ${describeFallback(id, a)}`
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

function allowanceNote(id: string, a: Allowance): string {
  return a.kind === 'fallback' ? describeFallback(id, a) : `other limits: ${otherLimits(a)}`
}

function describeFallback(id: string, a: FallbackAllowance): string {
  // A command provider has no turn cap, so its fallback turns mean nothing.
  const turns = Object.hasOwn(providers, id) ? `, ${counted(a.turns, 'turn')} each` : ''
  return `${counted(a.units, 'unit')}${turns} (${a.reason})`
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

/** A unit's result: its PR, `nothing`, or a report, and its verdict; `why` shapes a skip's or error's reason. */
function unitResult(u: UnitResult, why = (reason: string) => reason): string {
  if (u.status === 'skipped') return why(u.reason ?? '')
  const o = u.outcome
  const what =
    o?.kind === 'pr'
      ? o.url
      : o?.kind === 'pushed'
        ? `pushed onto ${o.url || o.branch}`
        : o?.kind === 'report'
          ? 'report'
          : why(o?.reason ?? '-')
  return u.verdict ? `${what}, verdict ${u.verdict}` : what
}

const CELL = 60

/** A cell's first line, clipped: `--unit` has the rest. */
function brief(text: string, clipAt = CELL): string {
  const [first = '', ...rest] = text.split('\n')
  return clip(rest.length > 0 ? `${first.trimEnd()}…` : first, clipAt)
}

/** One row per chain, numbered as `report --unit` takes them: item, skills, status and result, then its summary or title; the result and title clipped at `clipAt`. */
export function reportUnitRows(
  r: RunReport,
  clipAt = TITLE,
): { cells: string[]; summary?: string }[] {
  return chains(r).map((chain, i) => {
    const top = chain.head.planned.unit.items[0]
    const why = (reason: string) => brief(reason, clipAt)
    const [status, result] = chainCells(chain, (u) => unitResult(u, why), false)
    return {
      cells: [
        String(i + 1),
        top ? shortRef(top) : chain.head.planned.unit.id,
        chain.skills,
        brief(status),
        result,
      ],
      summary: chain.head.summary ?? (top && clip(top.title, clipAt)),
    }
  })
}

function reportUnitLines(r: RunReport, styled: boolean): string[] {
  const { header, units } = reportUnitTable(r, styled)
  return units.length === 0 ? ['  none'] : indent([header, ...units.flat()])
}

/** The units table, unindented: each chain's row, then its summary. */
export function reportUnitTable(
  r: RunReport,
  styled: boolean,
  clipAt = TITLE,
): { header: string; units: string[][] } {
  const rows = reportUnitRows(r, clipAt)
  const header = ['', 'item', 'skill', 'status', 'result']
  const lines = table([header, ...rows.map((row) => row.cells)], (cell, i, c) =>
    styled && i > 0 && c === 3 ? styleText(statusStyle(cell), cell) : cell,
  )
  const under = ' '.repeat(String(rows.length).length + 2)
  return {
    header: styler(styled)('bold', lines[0] ?? ''),
    units: rows.map((row, i) => [
      lines[i + 1] ?? '',
      ...(row.summary ? [styler(styled)('dim', `${under}${row.summary}`)] : []),
    ]),
  }
}

/** The run's headline and when it ran. */
export function runHeader(r: RunReport, style: Style = (_, text) => text): string[] {
  const span = `${localTime(new Date(r.startedAt))} to ${localTime(new Date(r.finishedAt))}`
  return [style('bold', runHeadline(r)), span]
}

/** A run as text from its report.json: units with their summaries, what needs you, skip counts, quota. */
export function formatRun(r: RunReport, warnings: string[] = [], styled = false): string {
  const style = styler(styled)
  const out = [...runHeader(r, style), '', ...warningLines(warnings, styled)]
  out.push(heading('Units', chains(r).length, style), ...reportUnitLines(r, styled))
  out.push(...needsYouLines(r.plan.skipped, style), ...skippedLines(r.plan.skipped, style))
  const quota = quotaLines(r)
  if (quota.length > 0) out.push('', style('bold', 'Quota'), ...indent(quota))
  const hints: [string, string][] = []
  if (r.results.length > 0) hints.push([`awaywork report ${r.runId} --unit <n|key>`, 'shows one'])
  if (r.plan.skipped.length > 0)
    hints.push([`awaywork report ${r.runId} --skipped [kind]`, 'lists the skipped items'])
  if (hints.length > 0) out.push('', ...hintLines(style, hints))
  return out.join('\n')
}

/** The run's chains `name` names by a step's unit id or item, else the one it numbers in the units table: a numeric key wins. */
export function findChains(r: RunReport, name: string): { chain: Chain; n: number }[] {
  const listed = chains(r).map((chain, i) => ({ chain, n: i + 1 }))
  const named = listed.filter(({ chain }) => {
    const isStep = chain.steps.some((s) => s.planned.unit.id === name.toLowerCase())
    return isStep || chain.head.planned.unit.items.some((i) => isNamed(i, name))
  })
  if (named.length > 0 || !/^\d+$/.test(name)) return named
  return listed.filter(({ n }) => n === Number(name))
}

/** One unit in full: its links, its steps, the files it left that are still there, then its PR body or report. */
export function formatUnit(
  { chain, n }: { chain: Chain; n: number },
  files: string[],
  body: string | undefined,
  styled = false,
): string {
  const { head } = chain
  const top = head.planned.unit.items[0]
  const [status, result] = chainCells(chain, unitResult, false)
  const rows = [
    ['skill', chain.skills],
    ['status', status],
    ...(head.loop ? [['loop', head.loop]] : []),
    ['result', result],
    ['item', top?.url ?? '-'],
    // One step's line would only repeat the status and result.
    ...(chain.steps.length > 1
      ? table(chain.steps.map((s) => stepCells(s).map((c) => brief(c))))
      : []
    ).map((line, i) => [i ? '' : 'steps', line]),
    ...files.map((file, i) => [i ? '' : 'files', file]),
  ].flatMap(([label = '', value = '']) => block(value).map((line, i) => [i ? '' : label, line]))
  const ref = top ? shortRef(top) : head.planned.unit.id
  const out = [styler(styled)('bold', `${n}  ${ref}  ${top?.title ?? ''}`), ...indent(table(rows))]
  const text = body?.trim() || head.summary
  if (text) out.push('', text)
  return out.join('\n')
}

/** A value's lines, the ones after the first indented under it. */
const block = (value: string) =>
  value
    .split('\n')
    .filter((line, i) => i === 0 || line.trim())
    .map((line, i) => (i ? `  ${line.trimEnd()}` : line))

/** The end of `run`: the units as `report` lists them, and where the report is. */
export function summarize(r: RunReport, reportPath: string): string {
  return [runHeadline(r), ...reportUnitLines(r, true), `Report: ${reportPath}`].join('\n')
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
