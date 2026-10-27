import type { Outcome } from '../worker/publish.js'
import type { WorkerStatus } from '../worker/run.js'
import { type Allowance, pct } from './budget.js'
import {
  bySlice,
  describeChain,
  needsYou,
  type PlannedUnit,
  type RunPlan,
  type SkipKind,
  type Skipped,
  shortRef,
} from './foreman.js'
import type { Item, Quota } from './types.js'

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
  /** What the step concluded, in a line: its slice's PR body when it leads the slice, else its report. */
  summary?: string
  /** What the step left, relative to the run dir, whichever exist. */
  files?: StepFiles
}

export interface StepFiles {
  log?: string
  report?: string
  /** The step's own commits. */
  diff?: string
  /** On the slice's first step: the PR body or push summary (a report chain's joined report) as published. */
  sliceBody?: string
  /** On the slice's first step: the commits it published. */
  sliceDiff?: string
}

/** A skip as report.json holds it: one written before skips had kinds has none. */
export type ReportedSkip = Omit<Skipped, 'kind'> & Partial<Pick<Skipped, 'kind'>>

/** Whether you can act to make the skipped item run; a skip without a kind doesn't say. */
export const needsYouOn = (s: ReportedSkip): s is Skipped => !!s.kind && needsYou[s.kind]

export interface RunReport {
  runId: string
  dryRun: boolean
  startedAt: Date
  finishedAt: Date
  plan: Omit<RunPlan, 'skipped'> & { skipped: ReportedSkip[] }
  results: UnitResult[]
  /** The last quota a worker saw, per provider. */
  quotas: Record<string, Quota>
}

const SUMMARY_LENGTH = 200

/** A PR body's or report's first paragraph on one line, past the body's title line, any heading or rule, and a gates section where none fired. */
export function summaryOf(text: string, titled = false): string | undefined {
  const body = text
    .replace(/<!--[\s\S]*?-->/g, '')
    .trim()
    .split('\n')
    .slice(titled ? 1 : 0)
    .join('\n')
  const paragraph = body
    .split(/\n\s*\n/)
    .map((p) =>
      p
        .split('\n')
        .filter((line) => !/^(#{1,6}(\s|$)|---$)/.test(line.trim()))
        .join(' ')
        .replace(/\s+/g, ' ')
        .trim(),
    )
    .find((p) => p && !p.startsWith('Gates: none fired'))
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
    out.push(
      `## Warnings (${warnings.length})`,
      '',
      ...warnings.map((w) => `- ${w.replace(/\n(?=.)/g, '\n  ')}`),
      '',
    )
  out.push(`## Units (${chains(r).length})`, '')
  if (r.results.length === 0) out.push('None.')
  else {
    out.push('| # | Unit | Skill | Provider | Status | Result |', '|---|---|---|---|---|---|')
    const row = (cells: (string | number)[]) => {
      const escaped = cells.map((c) => String(c).replaceAll('|', '\\|'))
      out.push(`| ${escaped.join(' | ').replaceAll('\n', ' ')} |`)
    }
    const listed = chains(r)
    listed.forEach((chain, i) => {
      const { head, steps, skills, slices } = chain
      row([i + 1, linkedItem(head), skills, providers(steps), ...chainCells(chain)])
      const stepRow = (s: UnitResult, indent: string) => {
        const [id, ...cells] = stepCells(s)
        row(['', `${indent}└ ${id}`, ...cells])
      }
      // A chain of one step is its own row; a longer one lists every step that was listed under it, by slice when it has several.
      if (slices.length > 1)
        slices.forEach((slice, k) => {
          const u = chainOf(slice.steps)
          row(['', `└ slice ${k + 1}`, slice.skills, providers(slice.steps), status(u), result(u)])
          for (const s of slice.steps) stepRow(s, '  ')
        })
      else if (steps.length > 1) for (const s of steps) stepRow(s, '')
    })
    const summed = listed.filter((c) => c.head.summary).map(({ head }) => head)
    if (summed.length > 0) out.push('', ...summed.map((u) => `- **${refOf(u)}**: ${u.summary}`))
  }
  const waiting = r.plan.skipped.filter(needsYouOn)
  if (waiting.length > 0) {
    out.push('', `## Needs you (${waiting.length})`, '')
    for (const s of waiting) out.push(`- [${refAndTitle(s.item)}](${s.item.url}): ${s.reason}`)
  }
  const rest = r.plan.skipped.filter((s) => !needsYouOn(s))
  if (rest.length > 0) {
    out.push('', `<details><summary>Skipped (${rest.length})</summary>`)
    const lines = (list: ReportedSkip[]) => list.map((s) => `- ${shortRef(s.item)}: ${s.reason}`)
    const groups = byKind(rest)
    if (!groups) out.push('', ...lines(rest))
    for (const [kind, list] of groups ?? [])
      out.push('', `### ${kind} (${list.length})`, '', ...lines(list))
    out.push('', '</details>')
  }
  out.push('', '## Quota', '')
  if (Object.keys(r.plan.allowances).length === 0) out.push('None.')
  for (const line of quotaLines(r)) out.push(`- ${line}`)

  const reports = r.results.filter((u) => u.outcome && 'text' in u.outcome)
  if (reports.length > 0) {
    out.push('', '## Reports')
    for (const u of reports) {
      const top = u.planned.unit.items[0]
      const text = u.outcome && 'text' in u.outcome ? u.outcome.text : ''
      out.push(
        '',
        `### ${refOf(u)}: ${top?.title} (${u.planned.unit.skill})`,
        '',
        top?.url ?? '',
        '',
      )
      if (u.summary) out.push(u.summary, '')
      // Under this `###`, the report's own headings start at `####`.
      out.push('<details><summary>Full report</summary>', '', demote(text.trim(), 4))
      out.push('', '</details>')
    }
  }
  return `${out.join('\n')}\n`
}

/** `3 units`, `1 unit`. */
export const counted = (n: number, what: string) => `${n} ${what}${n === 1 ? '' : 's'}`

/** `Run <id>: 1 PR, 1 draft PR, 2 reports, 1 pending review, 3 units`. */
export function runHeadline(r: RunReport): string {
  const count = (kind: Outcome['kind']) => r.results.filter((u) => u.outcome?.kind === kind).length
  const ready = r.results.filter((u) => u.outcome?.kind === 'pr' && u.outcome.ready).length
  const dry = r.dryRun ? ' (dry run)' : ''
  return `Run ${r.runId}${dry}: ${prCounts(ready, count('pr') - ready)}, ${counted(count('report'), 'report')}${reviewCount(count('review'))}, ${counted(chains(r).length, 'unit')}`
}

/** `, 1 pending review`, only when there are some. */
const reviewCount = (n: number) => (n ? `, ${counted(n, 'pending review')}` : '')

/** `1 PR, 1 draft PR`; ready PRs only when there are some. */
function prCounts(ready: number, drafts: number): string {
  if (!ready) return counted(drafts, 'draft PR')
  return drafts ? `${counted(ready, 'PR')}, ${counted(drafts, 'draft PR')}` : counted(ready, 'PR')
}

function refOf(u: UnitResult): string {
  const top = u.planned.unit.items[0]
  return top ? shortRef(top) : u.planned.unit.id
}

const refAndTitle = (item: Item) => `${shortRef(item)} ${item.title}`.replace(/[[\]]/g, '\\$&')

function linkedItem(u: UnitResult): string {
  const top = u.planned.unit.items[0]
  return top ? `[${refAndTitle(top)}](${top.url})` : u.planned.unit.id
}

/** Skipped items by kind, the largest group first; none when a skip has no kind, as in a report.json from before kinds. */
export function byKind(skipped: ReportedSkip[]): [SkipKind, Skipped[]][] | undefined {
  if (!skipped.every((s): s is Skipped => !!s.kind)) return undefined
  const groups = new Map<SkipKind, Skipped[]>()
  for (const s of skipped) groups.set(s.kind, [...(groups.get(s.kind) ?? []), s])
  return [...groups].sort((a, b) => b[1].length - a[1].length)
}

/** Shifts markdown headings outside code fences so the topmost is at `level`. */
function demote(text: string, level: number): string {
  let fenced = false
  const lines = text.split('\n').map((line) => {
    if (/^\s*(```|~~~)/.test(line)) fenced = !fenced
    return { line, depth: fenced ? 0 : (/^(#{1,6})\s/.exec(line)?.[1]?.length ?? 0) }
  })
  const shift = Math.max(0, level - Math.min(...lines.map((l) => l.depth || 7)))
  return lines
    .map(({ line, depth }) =>
      depth ? `${'#'.repeat(Math.min(6, depth + shift))}${line.slice(depth)}` : line,
    )
    .join('\n')
}

export interface Chain {
  head: UnitResult
  steps: UnitResult[]
  skills: string
  slices: { steps: UnitResult[]; skills: string }[]
}

/** The run's results grouped by chain and slice, with what the plan chained: e.g. `implement → loop(review ⇄ fix)`. */
export function chains(r: RunReport): Chain[] {
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

/** A chain's status and result; with several slices, each slice's result in turn, its loops on its own row. `loops: false` keeps them out of the status. */
export function chainCells(
  { steps, slices }: Chain,
  show = result,
  loops = true,
): [string, string] {
  const chain = chainOf(steps)
  const capped = chain.planned.capped ? ` (${chain.planned.capped})` : ''
  const loop = loops && slices.length === 1 ? chain.loop : undefined
  const cell = `${status({ ...chain, loop })}${capped}`
  if (slices.length === 1 || chain.status === 'skipped') return [cell, show(chain)]
  return [cell, slices.map((slice) => show(chainOf(slice.steps))).join('; ')]
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

/** A step's id, skill, provider, status and what it left. */
export function stepCells(s: UnitResult): string[] {
  return [s.planned.unit.id, s.planned.unit.skill, s.provider ?? '-', stepStatus(s), stepResult(s)]
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
  const prs = parts.filter((r) =>
    /^https:\/\/\S+ \(\d+ commits?(, ready for review|, draft: .+)?\)(, verdict \S+)?$/.test(r),
  )
  const ready = prs.filter((r) => r.includes(', ready for review)')).length
  const reports = parts.filter((r) =>
    /^report below( \(not posted: .+\))?(, verdict \S+)?$/.test(r),
  ).length
  const reviews = parts.filter((r) =>
    /^https:\/\/\S+ \(pending review(, .+)?\)(, verdict \S+)?$/.test(r),
  ).length
  const dry = report.split('\n', 1)[0]?.endsWith('(dry run)') ? ' (dry run)' : ''
  return `${runId}  ${counted(results.length, 'unit')}, ${prCounts(ready, prs.length - ready)}, ${counted(reports, 'report')}${reviewCount(reviews)}${dry}`
}

function status(u: UnitResult): string {
  const turns = u.turns ? `, ${counted(u.turns, 'turn')}` : ''
  const why = [
    u.status !== 'skipped' && u.reason,
    u.retried && 'retried on the next model',
    u.loop && `loop: ${u.loop}`,
  ].filter(Boolean)
  return `${u.status}${turns}${why.length > 0 ? ` (${why.join('; ')})` : ''}`
}

/** `, ready for review` or `, draft: <why>` for a `deliver: pr` PR; a `draft_pr` one says nothing. */
export function opened(o: Extract<Outcome, { kind: 'pr' }>): string {
  if (o.ready) return ', ready for review'
  return o.draft ? `, draft: ${o.draft}` : ''
}

/** ` (not posted: <why>)` for a `deliver: pending_review` report left on no PR. */
export const unposted = (o: Extract<Outcome, { kind: 'report' }>) =>
  o.unposted ? ` (not posted: ${o.unposted})` : ''

/** `pending review`, and why its line comments were left out. */
export const reviewed = (o: Extract<Outcome, { kind: 'review' }>) =>
  o.note ? `pending review, ${o.note}` : 'pending review'

function result(u: UnitResult): string {
  if (u.status === 'skipped') return u.reason ?? ''
  const verdict = u.verdict ? `, verdict ${u.verdict}` : ''
  if (u.outcome?.kind === 'pr')
    return `${u.outcome.url} (${counted(u.outcome.commits, 'commit')}${opened(u.outcome)})${verdict}`
  if (u.outcome?.kind === 'report') return `report below${unposted(u.outcome)}${verdict}`
  if (u.outcome?.kind === 'review') return `${u.outcome.url} (${reviewed(u.outcome)})${verdict}`
  if (u.outcome?.kind === 'pushed') {
    const gated = u.outcome.gated ? `, ${u.outcome.gated}` : ''
    return `${counted(u.outcome.commits, 'commit')} pushed onto ${u.outcome.branch}${gated}, report below${verdict}`
  }
  return `${u.outcome?.reason ?? '-'}${verdict}`
}

/** Each provider's long window before and after the run, against its ceiling. */
export function quotaLines(r: RunReport): string[] {
  return Object.entries(r.plan.allowances).map(([id, a]) => {
    const units = r.results.filter((u) => u.provider === id)
    return `${id}: ${quotaLine(a, r.quotas[id], units)}`
  })
}

function quotaLine(a: Allowance, last: Quota | undefined, units: UnitResult[]): string {
  if (a.kind === 'fallback')
    return `fallback, ${units.length} of ${counted(a.units, 'unit')} (${a.reason})`
  const long = last?.windows.find((w) => w.name === a.window)?.used ?? a.used
  const short = last?.windows.find((w) => w.span === 'short')
  const session = a.session
    ? `; session ${pct(a.session.used)} to ${pct(short?.used ?? a.session.used)}, stop at ${pct(a.session.stopAt)}`
    : ''
  return `${a.window} ${pct(a.used)} to ${pct(long)}, ceiling ${pct(a.ceiling)}${session}`
}
