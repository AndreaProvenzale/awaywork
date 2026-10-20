import type { Outcome } from '../worker/publish.js'
import type { WorkerStatus } from '../worker/run.js'
import { type Allowance, pct } from './budget.js'
import { bySlice, describeChain, type PlannedUnit, type RunPlan } from './foreman.js'
import type { Quota } from './types.js'

export interface UnitResult {
  planned: PlannedUnit
  provider?: string
  status: WorkerStatus | 'prepared' | 'skipped' | 'error'
  reason?: string
  turns?: number
  /** The long window before the unit and the worker's last quota reading, to tell what the unit used. */
  baseline?: { name: string; used: number; resetsAt: number }
  quota?: Quota
  /** What the chain published, on its first step. */
  outcome?: Outcome
  /** The one word the unit wrote to `out/verdict`. */
  verdict?: string
  /** Skipped because its `when` didn't hold, or after a step that left nothing: not a failure. */
  passedOver?: true
  /** Failed, and ran again on its provider's next model: the retry is the next result. */
  retried?: true
  /** The step's folder under its chain's `units/<id>/`, e.g. `2-review`, once it started. */
  step?: string
  /** What the step left for the chain, e.g. `2 commits and a report`. */
  made?: string
  /** The step left a report. */
  reported?: true
  /** How the chain's loops went, on its first step, e.g. `2 rounds of review ⇄ fix; until held: verdict approve`. */
  loop?: string
  /** What the step concluded, in a line: its slice's PR body when it published the slice, else its report. */
  summary?: string
  /** What the step left, relative to the run dir: its log, report and diff, then the PR body and diff of the slice it published. */
  files?: string[]
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

const SUMMARY_LENGTH = 200

/** A PR body's or report's first paragraph on one line, past the body's title line and any heading. */
export function summaryOf(text: string, titled = false): string | undefined {
  const body = text
    .trim()
    .split('\n')
    .slice(titled ? 1 : 0)
    .join('\n')
  const paragraph = body
    .split(/\n\s*\n/)
    .map((p) =>
      p
        .split('\n')
        .filter((line) => !/^#{1,6}(\s|$)/.test(line.trim()))
        .join(' ')
        .replace(/\s+/g, ' ')
        .trim(),
    )
    .find(Boolean)
  if (!paragraph || paragraph.length <= SUMMARY_LENGTH) return paragraph
  return `${paragraph.slice(0, SUMMARY_LENGTH - 1).trimEnd()}…`
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
    const row = (cells: (string | number)[]) => {
      const escaped = cells.map((c) => String(c).replaceAll('|', '\\|'))
      out.push(`| ${escaped.join(' | ').replaceAll('\n', ' ')} |`)
    }
    chains(r).forEach((chain, i) => {
      const { head, steps, skills, slices } = chain
      row([i + 1, head.planned.unit.id, skills, providers(steps), ...chainCells(chain)])
      const stepRow = (s: UnitResult, indent: string) =>
        row([
          '',
          `${indent}└ ${s.planned.unit.id}`,
          s.planned.unit.skill,
          s.provider ?? '-',
          stepStatus(s),
          stepResult(s),
        ])
      // A chain of one step is its own row; a longer one lists every step that was listed under it, by slice when it has several.
      if (slices.length > 1)
        slices.forEach((slice, k) => {
          const u = chainOf(slice.steps)
          row(['', `└ slice ${k + 1}`, slice.skills, providers(slice.steps), status(u), result(u)])
          for (const s of slice.steps) stepRow(s, '  ')
        })
      else if (steps.length > 1) for (const s of steps) stepRow(s, '')
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
  const listed = chains(r)
  const head = `Run ${r.runId}: ${count('pr')} draft PRs, ${count('report')} reports, ${listed.length} units`
  const line = (indent: string, s: UnitResult) =>
    `${indent}${s.planned.unit.id}  ${stepStatus(s)}  ${stepResult(s)}`
  const rows = listed.flatMap((chain) => [
    `  ${chain.head.planned.unit.id}  ${chainCells(chain).join('  ')}`,
    ...(chain.slices.length > 1
      ? chain.slices.flatMap(({ steps }, k) => [
          `    slice ${k + 1}  ${status(chainOf(steps))}  ${result(chainOf(steps))}`,
          ...steps.map((s) => line('      ', s)),
        ])
      : chain.steps.length > 1
        ? chain.steps.map((s) => line('    ', s))
        : []),
  ])
  return [head, ...rows, `Report: ${reportPath}`].join('\n')
}

interface Chain {
  head: UnitResult
  steps: UnitResult[]
  skills: string
  slices: { steps: UnitResult[]; skills: string }[]
}

/** The run's results grouped by chain and slice, with what the plan chained: e.g. `implement → loop(review ⇄ fix)`. */
function chains(r: RunReport): Chain[] {
  return r.results
    .filter((u) => !u.planned.chain && !u.retried)
    .map((head) => {
      const { id } = head.planned.unit
      const steps = r.results.filter((u) => u.planned.unit.id === id || u.planned.chain === id)
      const planned = r.plan.units.filter((p) => p.unit.id === id || p.chain === id)
      const plannedSlices = bySlice(planned, (p) => p.slice)
      const slices = bySlice(steps, (u) => u.planned.slice).map((steps, k) => ({
        steps,
        skills: describeChain(plannedSlices[k] ?? []),
      }))
      return { head, steps, skills: describeChain(planned), slices }
    })
}

/** A chain's status and result; with several slices, each slice's result in turn, its loops on its own row. */
function chainCells({ steps, slices }: Chain): [string, string] {
  const chain = chainOf(steps)
  const capped = chain.planned.capped ? ` (${chain.planned.capped})` : ''
  if (slices.length === 1 || chain.status === 'skipped')
    return [`${status(chain)}${capped}`, result(chain)]
  const each = slices.map((slice) => result(chainOf(slice.steps)))
  return [`${status({ ...chain, loop: undefined })}${capped}`, each.join('; ')]
}

/** A chain as one result: its first step's last attempt, with every step's turns and the latest verdict. */
function chainOf(steps: UnitResult[]): UnitResult {
  const head = steps.find((s) => !s.retried) as UnitResult
  if (steps.length === 1) return head
  const turns = steps.reduce((sum, s) => sum + (s.turns ?? 0), 0)
  return { ...head, turns, verdict: steps.findLast((s) => s.verdict)?.verdict }
}

function providers(steps: UnitResult[]): string {
  return [...new Set(steps.flatMap((s) => s.provider ?? []))].join(', ') || '-'
}

/** A step's own status: how the chain's loops went is on the chain's row. */
function stepStatus(u: UnitResult): string {
  return status({ ...u, loop: undefined })
}

function stepResult(u: UnitResult): string {
  if (u.status === 'skipped') return u.reason ?? ''
  return [u.made ?? '-', u.verdict && `verdict ${u.verdict}`].filter(Boolean).join(', ')
}

/** One line per run for `report --list`, counted from the units table of its report.md. */
export function runLine(runId: string, report: string | undefined): string {
  if (report === undefined) return `${runId}  no report`
  const results = report
    .split('\n')
    .filter((line) => /^\| \d+ \|/.test(line))
    .map((line) => line.slice(2, -2).split(' | ').at(-1) ?? '')
  // A chain of several slices lists each one's result, separated by `; `.
  const parts = results.flatMap((r) => r.split('; '))
  const prs = parts.filter((r) => /^https:\/\/\S+ \(\d+ commits\)(, verdict \S+)?$/.test(r)).length
  const reports = parts.filter((r) => /^report below(, verdict \S+)?$/.test(r)).length
  const dry = report.split('\n', 1)[0]?.endsWith('(dry run)') ? ' (dry run)' : ''
  return `${runId}  ${results.length} units, ${prs} draft PRs, ${reports} reports${dry}`
}

function status(u: UnitResult): string {
  const turns = u.turns ? `, ${u.turns} turns` : ''
  const why = [
    u.status !== 'skipped' && u.reason,
    u.retried && 'retried on the next model',
    u.loop && `loop: ${u.loop}`,
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
