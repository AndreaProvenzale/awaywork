import type { Outcome } from '../worker/publish.js'
import type { WorkerStatus } from '../worker/run.js'
import { type Allowance, pct } from './budget.js'
import type { NightPlan, PlannedUnit } from './foreman.js'
import type { Quota } from './types.js'

export interface UnitResult {
  planned: PlannedUnit
  provider?: string
  status: WorkerStatus | 'prepared' | 'skipped' | 'error'
  reason?: string
  turns?: number
  outcome?: Outcome
}

export interface NightReport {
  runId: string
  dryRun: boolean
  startedAt: Date
  finishedAt: Date
  plan: NightPlan
  results: UnitResult[]
  /** The last quota a worker saw, per provider. */
  quotas: Record<string, Quota>
}

/** The morning report as markdown: units, skipped items, quota against each ceiling, report-only outputs. */
export function formatReport(r: NightReport): string {
  const out = [
    `# Night shift ${r.runId}${r.dryRun ? ' (dry run)' : ''}`,
    '',
    `${r.startedAt.toISOString()} to ${r.finishedAt.toISOString()}`,
    '',
    '## Units',
    '',
  ]
  if (r.results.length === 0) out.push('None.')
  else {
    out.push('| # | Unit | Skill | Provider | Status | Result |', '|---|---|---|---|---|---|')
    r.results.forEach((u, i) => {
      const { unit } = u.planned
      const cells = [i + 1, unit.id, unit.skill, u.provider ?? '-', status(u), result(u)]
      out.push(`| ${cells.join(' | ').replaceAll('\n', ' ')} |`)
    })
  }
  if (r.plan.skipped.length > 0) {
    out.push('', '## Skipped items', '')
    for (const s of r.plan.skipped) out.push(`- ${s.item.source} ${s.item.key}: ${s.reason}`)
  }
  out.push('', '## Quota', '')
  for (const [id, a] of Object.entries(r.plan.allowances)) {
    const units = r.results.filter((u) => u.provider === id)
    out.push(`- ${id}: ${quotaLine(a, r.quotas[id], units)}`)
  }

  const reports = r.results.filter((u) => u.outcome?.kind === 'report')
  if (reports.length > 0) {
    out.push('', '## Reports')
    for (const u of reports) {
      const top = u.planned.unit.items[0]
      const text = u.outcome?.kind === 'report' ? u.outcome.text : ''
      out.push('', `### ${u.planned.unit.id}: ${top?.title} (${u.planned.unit.skill})`, '')
      out.push(top?.url ?? '', '', text)
    }
  }
  return `${out.join('\n')}\n`
}

/** A few lines for the terminal. */
export function summarize(r: NightReport, reportPath: string): string {
  const count = (kind: Outcome['kind']) => r.results.filter((u) => u.outcome?.kind === kind).length
  const head = `Run ${r.runId}: ${count('pr')} draft PRs, ${count('report')} reports, ${r.results.length} units`
  const rows = r.results.map((u) => `  ${u.planned.unit.id}  ${status(u)}  ${result(u)}`)
  return [head, ...rows, `Report: ${reportPath}`].join('\n')
}

/** One line per run for `report --list`, counted from the units table of its report.md. */
export function runLine(runId: string, report: string | undefined): string {
  if (report === undefined) return `${runId}  no report`
  const results = report
    .split('\n')
    .filter((line) => /^\| \d+ \|/.test(line))
    .map((line) => line.slice(2, -2).split(' | ').at(-1) ?? '')
  const prs = results.filter((r) => /^https:\/\/\S+ \(\d+ commits\)$/.test(r)).length
  const reports = results.filter((r) => r === 'report below').length
  const dry = report.split('\n', 1)[0]?.endsWith('(dry run)') ? ' (dry run)' : ''
  return `${runId}  ${results.length} units, ${prs} draft PRs, ${reports} reports${dry}`
}

function status(u: UnitResult): string {
  const turns = u.turns ? `, ${u.turns} turns` : ''
  return `${u.status}${turns}${u.reason && u.status !== 'skipped' ? ` (${u.reason})` : ''}`
}

function result(u: UnitResult): string {
  if (u.status === 'skipped') return u.reason ?? ''
  if (u.outcome?.kind === 'pr') return `${u.outcome.url} (${u.outcome.commits} commits)`
  if (u.outcome?.kind === 'report') return 'report below'
  return u.outcome?.reason ?? '-'
}

function quotaLine(a: Allowance, last: Quota | undefined, units: UnitResult[]): string {
  if (a.kind === 'fallback') return `fallback, ${units.length} of ${a.units} units (${a.reason})`
  const long = last?.windows.find((w) => w.name === a.window)?.used ?? a.used
  const short = last?.windows.find((w) => w.span === 'short')
  const session = a.session
    ? `; session ${pct(a.session.used)} to ${pct(short?.used ?? a.session.used)}, stop at ${pct(a.session.stopAt)}`
    : ''
  return `${a.window} ${pct(a.used)} to ${pct(long)}, ceiling ${pct(a.ceiling)}${session}`
}
