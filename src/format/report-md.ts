import type { Item, Quota } from '#core/types'
import { shortRef } from '#plan/foreman'
import type { PostState } from '#posts/comments'
import {
  byKind,
  type Chain,
  type Commented,
  chains,
  type Moved,
  needsYouOn,
  oldestFirst,
  type PlanPost,
  type Questions,
  type ReportedSkip,
  type RunReport,
  type UnitResult,
} from '#posts/report'
import { type Allowance, modelCeiling, pct, presenceLine } from '#quota/budget'
import { ageSince, counted, localTime } from '#util/text'
import type { Outcome } from '#worker/deliver/publish'

/** `; it waits for your approve, holding the move to "Ready"`, or `; it went ahead, gates clear: product`. */
const describePost = (post: PostState | undefined): string => {
  if (!post) return ''
  if ('went' in post)
    return `; it went ahead${post.gates.length ? `, gates clear: ${post.gates.join(', ')}` : ''}`
  return `; it waits for your approve${post.move ? `, holding the move to "${post.move}"` : ''}`
}

/** `questions posted on <url>`, or why they weren't. */
export const describeQuestions = (q: Questions): string =>
  q.unposted ? `questions not posted: ${q.unposted}` : `questions posted on ${q.url}`

/** `plan posted on <url>, tasks api, web`, or why it wasn't. */
export const describePlan = (p: PlanPost): string =>
  p.unposted
    ? `plan not posted: ${p.unposted}`
    : `plan posted on ${p.url}, tasks ${p.tasks?.join(', ')}${describePost(p.post)}`

/** `moved ENG-12 to "In Review"`, or why it couldn't. */
export function describeMoved(m: Moved): string {
  const key = m.item.slice(m.item.indexOf(':') + 1)
  return m.failed ? `couldn't move ${key} to "${m.to}": ${m.failed}` : `moved ${key} to "${m.to}"`
}

/** `result posted on <url>`, or why it couldn't. */
export function describeResult(c: Commented): string {
  const key = c.item.slice(c.item.indexOf(':') + 1)
  return c.failed
    ? `couldn't post its result on ${key}: ${c.failed}`
    : `result posted on ${c.url}${describePost(c.post)}`
}

/** The notes of the chain's steps after the first, each tagged with its step's id; a note the first step left too is dropped. */
export const laterNotes = ({ head, steps }: Chain): string[] => {
  const seen = new Set(head.notes)
  return steps
    .filter((s) => s !== head)
    .flatMap((s) =>
      (s.notes ?? []).filter((n) => !seen.has(n)).map((n) => `${s.planned.unit.id}: ${n}`),
    )
}

/** What a chain's first step wrote to its items, in order: its questions or its plan, then its result and on_done's moves. */
export const unitNotes = (u: UnitResult): string[] => [
  ...(u.notes ?? []),
  ...(u.questions ? [describeQuestions(u.questions)] : []),
  ...(u.byHand ? [u.byHand] : []),
  ...(u.plan ? [describePlan(u.plan)] : []),
  ...(u.store ?? []),
  ...(u.result ?? []).map(describeResult),
  ...(u.moved ?? []).map((m) => `on_done ${describeMoved(m)}`),
]

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
  if (r.plan.moved?.length)
    out.push(
      `## Held moves (${r.plan.moved.length})`,
      '',
      ...r.plan.moved.map((m) => `- on_done ${describeMoved(m)}, its post approved`),
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
      const { head, steps, skills } = chain
      row([i + 1, linkedItem(head), skills, providers(steps), ...chainCells(chain)])
      // A chain of one step is its own row; a longer one lists every step that was listed under it.
      if (steps.length > 1)
        for (const s of steps) {
          const [id, ...cells] = stepCells(s)
          row(['', `└ ${id}`, ...cells])
        }
    })
    const summed = listed.filter((c) => c.head.summary).map(({ head }) => head)
    if (summed.length > 0) out.push('', ...summed.map((u) => `- **${refOf(u)}**: ${u.summary}`))
    const notes = listed.flatMap((chain) =>
      [...unitNotes(chain.head), ...laterNotes(chain)].map(
        (note) => `- **${refOf(chain.head)}**: ${note}`,
      ),
    )
    if (notes.length > 0) out.push('', ...notes)
  }
  const waiting = r.plan.skipped.filter(needsYouOn).sort(oldestFirst)
  if (waiting.length > 0) {
    out.push('', `## Needs you (${waiting.length})`, '')
    const age = (s: ReportedSkip) =>
      s.since ? ` (${ageSince(s.since, new Date(r.startedAt).getTime())})` : ''
    for (const s of waiting)
      out.push(`- [${refAndTitle(s.item)}](${s.item.url}): ${s.reason}${age(s)}`)
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

  const asked = r.results.filter((u) => u.questions)
  if (asked.length > 0) {
    out.push('', '## Questions')
    for (const u of asked) {
      const q = u.questions as Questions
      const top = u.planned.unit.items[0]
      out.push('', `### ${refOf(u)}: ${top?.title} (${q.step})`, '', describeQuestions(q), '')
      out.push(demote(q.text, 4))
    }
  }

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

/** A chain's status and result. `loops: false` keeps its loops out of the status. */
export function chainCells({ steps }: Chain, show = result, loops = true): [string, string] {
  const chain = chainOf(steps)
  return [status({ ...chain, loop: loops ? chain.loop : undefined }), show(chain)]
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
  // An older run's chain of several slices lists each one's result, separated by `; `.
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

/** ` (not posted: <why>)` for a `deliver: pending_review` report left on no PR, or one whose `on_done` a gate held back. */
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

/** Whether the run was away or present, then each provider's long window before and after the run, against its ceiling. */
export function quotaLines(r: RunReport): string[] {
  const providers = Object.entries(r.plan.allowances).map(([id, a]) => {
    const units = r.results.filter((u) => u.provider === id)
    return `${id}: ${quotaLine(a, r.quotas[id], units)}${modelLines(a, r.models?.[id])}`
  })
  return r.plan.present === undefined ? providers : [presenceLine(r.plan.present), ...providers]
}

function quotaLine(a: Allowance, last: Quota | undefined, units: UnitResult[]): string {
  if (a.kind === 'fallback' && a.present) return `sat out (${a.reason})`
  if (a.kind === 'fallback')
    return `fallback, ${units.length} of ${counted(a.units, 'unit')} (${a.reason})`
  const long = last?.windows.find((w) => w.name === a.window)?.used ?? a.used
  const short = last?.windows.find((w) => w.span === 'short')
  const session = a.session
    ? `; session ${pct(a.session.used)} to ${pct(short?.used ?? a.session.used)}, stop at ${pct(a.session.stopAt)}`
    : ''
  return `${a.window} ${pct(a.used)} to ${pct(long)}, ceiling ${pct(a.ceiling)}${session}`
}

/** E.g. `; seven_day_opus (opus) 64%, ceiling 80%`: no start value, as the probe's model can't read another's window. */
function modelLines(a: Allowance, models: Record<string, Quota['windows']> = {}): string {
  if (a.kind !== 'quota') return ''
  const ceiling = pct(modelCeiling(a))
  return Object.entries(models)
    .flatMap(([model, windows]) =>
      windows.map((w) => `; ${w.name} (${model}) ${pct(w.used)}, ceiling ${ceiling}`),
    )
    .join('')
}
