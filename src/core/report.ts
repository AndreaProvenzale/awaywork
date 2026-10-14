import type { Outcome } from '../worker/publish.js'
import type { WorkerStatus } from '../worker/run.js'
import { type Allowance, pct } from './budget.js'
import type { PlannedUnit, RunPlan } from './foreman.js'
import type { Quota } from './types.js'

export interface UnitResult {
  planned: PlannedUnit
  provider?: string
  status: WorkerStatus | 'prepared' | 'skipped' | 'error'
  reason?: string
  turns?: number
  /** The worker's first and last quota reading, to tell what the unit used. */
  firstQuota?: Quota
  quota?: Quota
  outcome?: Outcome
  /** The one word the unit wrote to `out/verdict`. */
  verdict?: string
  /** Skipped because its `when` didn't hold: its chain goes on from the unit before. */
  passedOver?: true
  /** How the loop this unit hosts went, e.g. `2 rounds of review ⇄ fix; until held: verdict approve`. */
  loop?: string
}

export interface RunReport {
  runId: string
  dryRun: boolean
  startedAt: Date
  finishedAt: Date
  plan: RunPlan
  results: UnitResult[]
  /** The last quota a worker saw, per provider. */
  quotas: Record<string, Quota>
}

/** `2026-10-09 20:11:02` in local time; sv-SE is the locale that formats so. */
export const localTime = (d: Date) => d.toLocaleString('sv-SE')

/** The morning report as markdown: plan warnings, units, skipped items, quota against each ceiling, report-only outputs. */
export function formatReport(r: RunReport, warnings: string[] = []): string {
  const out = [
    `# Awaywork ${r.runId}${r.dryRun ? ' (dry run)' : ''}`,
    '',
    `${localTime(r.startedAt)} to ${localTime(r.finishedAt)}, local time`,
    '',
  ]
  if (warnings.length > 0)
    out.push('## Warnings', '', ...warnings.map((w) => `- ${w.replace(/\n(?=.)/g, '\n  ')}`), '')
  out.push('## Units', '')
  if (r.results.length === 0) out.push('None.')
  else {
    out.push('| # | Unit | Skill | Provider | Status | Result |', '|---|---|---|---|---|---|')
    r.results.forEach((u, i) => {
      const { unit } = u.planned
      const cells = [i + 1, unit.id, unit.skill, u.provider ?? '-', status(u), result(u)]
      const escaped = cells.map((c) => String(c).replaceAll('|', '\\|'))
      out.push(`| ${escaped.join(' | ').replaceAll('\n', ' ')} |`)
    })
  }
  if (r.plan.skipped.length > 0) {
    out.push('', '## Skipped items', '')
    for (const s of r.plan.skipped) out.push(`- ${s.item.source} ${s.item.key}: ${s.reason}`)
  }
  out.push('', '## Quota', '')
  if (Object.keys(r.plan.allowances).length === 0) out.push('None.')
  for (const [id, a] of Object.entries(r.plan.allowances)) {
    const units = r.results.filter((u) => u.provider === id)
    out.push(`- ${id}: ${quotaLine(a, r.quotas[id], units)}`)
  }

  const reports = r.results.filter((u) => u.outcome && 'text' in u.outcome)
  if (reports.length > 0) {
    out.push('', '## Reports')
    for (const u of reports) {
      const top = u.planned.unit.items[0]
      const text = u.outcome && 'text' in u.outcome ? u.outcome.text : ''
      out.push('', `### ${u.planned.unit.id}: ${top?.title} (${u.planned.unit.skill})`, '')
      out.push(top?.url ?? '', '', text)
    }
  }
  return `${out.join('\n')}\n`
}

/** A few lines for the terminal. */
export function summarize(r: RunReport, reportPath: string): string {
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
  const prs = results.filter((r) =>
    /^https:\/\/\S+ \(\d+ commits\)(, verdict \S+)?$/.test(r),
  ).length
  const reports = results.filter((r) => /^report below(, verdict \S+)?$/.test(r)).length
  const dry = report.split('\n', 1)[0]?.endsWith('(dry run)') ? ' (dry run)' : ''
  return `${runId}  ${results.length} units, ${prs} draft PRs, ${reports} reports${dry}`
}

function status(u: UnitResult): string {
  const turns = u.turns ? `, ${u.turns} turns` : ''
  const why = [
    u.status !== 'skipped' && u.reason,
    u.loop && `loop: ${u.loop}`,
    u.planned.capped,
  ].filter(Boolean)
  return `${u.status}${turns}${why.length > 0 ? ` (${why.join('; ')})` : ''}`
}

function result(u: UnitResult): string {
  if (u.status === 'skipped') return u.reason ?? ''
  const verdict = u.verdict ? `, verdict ${u.verdict}` : ''
  if (u.outcome?.kind === 'pr') return `${u.outcome.url} (${u.outcome.commits} commits)${verdict}`
  if (u.outcome?.kind === 'report') return `report below${verdict}`
  if (u.outcome?.kind === 'pushed')
    return `${u.outcome.commits} commits pushed onto ${u.outcome.branch}, report below${verdict}`
  return `${u.outcome?.reason ?? '-'}${verdict}`
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
