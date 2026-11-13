import { styleText } from 'node:util'
import { isNamed, shortRef } from '../../plan/foreman.js'
import {
  type Chain,
  chainCells,
  chains,
  localTime,
  opened,
  quotaLines,
  type RunReport,
  reviewed,
  runHeadline,
  stepCells,
  type UnitResult,
  unitNotes,
  unposted,
} from '../../posts/report.js'
import { unitRef } from './plan.js'
import { needsYouLines, skippedLines } from './skips.js'
import {
  brief,
  clip,
  heading,
  hintLines,
  indent,
  type Style,
  styler,
  TITLE,
  table,
  warningLines,
} from './terminal.js'

/** A unit's result: its PR, `nothing`, or a report, and its verdict; `why` shapes a skip's or error's reason. */
function unitResult(u: UnitResult, why = (reason: string) => reason): string {
  if (u.status === 'skipped') return why(u.reason ?? '')
  const o = u.outcome
  const what =
    o?.kind === 'pr'
      ? `${o.url}${opened(o)}`
      : o?.kind === 'pushed'
        ? `pushed onto ${o.url || o.branch}${o.gated ? `, ${o.gated}` : ''}`
        : o?.kind === 'report'
          ? `report${unposted(o)}`
          : o?.kind === 'review'
            ? `${o.url} (${reviewed(o)})`
            : why(o?.reason ?? '-')
  return u.verdict ? `${what}, verdict ${u.verdict}` : what
}

/** One row per chain, numbered as `report --unit` takes them: item, skills, status and result, then its summary or title; the result and title clipped at `clipAt`. */
export function reportUnitRows(
  r: RunReport,
  clipAt = TITLE,
  inRepo = false,
): { cells: string[]; summary?: string; notes: string[] }[] {
  return chains(r).map((chain, i) => {
    const top = chain.head.planned.unit.items[0]
    const why = (reason: string) => brief(reason, clipAt)
    const [status, result] = chainCells(chain, (u) => unitResult(u, why), false)
    return {
      cells: [
        String(i + 1),
        unitRef(chain.head.planned.unit, inRepo),
        chain.skills,
        brief(status),
        result,
      ],
      summary: chain.head.summary ?? (top && clip(top.title, clipAt)),
      notes: unitNotes(chain.head),
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
  inRepo = false,
): { header: string; units: string[][] } {
  const rows = reportUnitRows(r, clipAt, inRepo)
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
      ...row.notes.map((line) => styler(styled)('dim', `${under}${line}`)),
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
