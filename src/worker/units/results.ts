import { existsSync } from 'node:fs'
import { join, posix } from 'node:path'
import type { Deliver } from '#core/types'
import { type StepFiles, summaryOf, type UnitResult } from '#posts/report'
import { outputFile, readOutput } from '#worker/clone/files'
import type { Outcome } from '#worker/deliver/publish'
import type { StepReport } from '#worker/deliver/slice'

/** A step that sat out, or its `when` or its rule's `quota` passed over: a poll tries it again an hour later. */
export const triedLater = (r: UnitResult) =>
  r.status === 'skipped' &&
  (!!r.reason?.startsWith('no provider left') ||
    (!!r.passedOver && /^(when |quota: )/.test(r.reason ?? '')))

/** Why a `deliver: pr` chain opens as a draft: a step that failed, stopped or never ran; `runLine` splits at `; `. */
export function notReady(r: UnitResult): string {
  const why = r.status === 'skipped' && r.reason?.split('\n')[0]?.split('; ')[0]
  return `${r.planned.unit.id} ${r.status}${why ? `: ${why}` : ''}`
}

/** A step's files, and what it concluded: the chain's PR body when it leads the chain, else its report. */
export async function leftBy(
  runDir: string,
  chainId: string,
  r: UnitResult,
  deliver: Deliver,
  lead: boolean,
): Promise<Pick<UnitResult, 'files' | 'summary'>> {
  if (!r.step) return {}
  // Relative and with `/`: report.json is read on other machines, from an uploaded artifact.
  const step = posix.join('units', chainId, r.step)
  const slice = posix.join('units', chainId, 'out')
  const all: StepFiles = {
    log: posix.join(step, 'worker.log'),
    report: posix.join(step, 'out', outputFile.report),
    diff: posix.join(step, 'out', 'diff.patch'),
    ...(lead && {
      sliceBody: posix.join(slice, outputFile[deliver]),
      sliceDiff: posix.join(slice, 'diff.patch'),
    }),
  }
  const files: StepFiles = Object.fromEntries(
    Object.entries(all).filter(([, f]) => existsSync(join(runDir, f))),
  )
  const read = async (f?: string) => (f ? readOutput(join(runDir, f)) : '')
  // Only a PR's body opens with its title.
  const summary =
    summaryOf(await read(files.sliceBody), deliver === 'draft_pr' || deliver === 'pr') ||
    summaryOf(await read(files.report))
  return { files, ...(summary && { summary }) }
}

/** A lean post's text: the gates' card, then the step's `summary.md`, else its report's first lines, saying so in `notes`. */
export async function leanText(
  out: string,
  outcome: Outcome | undefined,
  reports: StepReport[],
  notes: string[],
): Promise<string> {
  const written = (await readOutput(join(out, 'summary.md'))).trim()
  if (!written) notes.push("no summary.md: the post shows the report's first lines")
  const summary = written || (reports.at(-1)?.text ?? '').split('\n').slice(0, 5).join('\n').trim()
  const card = outcome?.kind === 'report' ? outcome.gates?.card : undefined
  return card ? `${card}\n\n${summary}` : summary
}

/** A chain's outcome that published: a PR, a push, a report or a pending review left. */
export const delivered = (o: Outcome | undefined) =>
  !!o && o.kind !== 'none' && !(o.kind === 'report' && o.unposted)

/** A finished chain's result: its report, or a line linking what it published. */
export function resultOf(o: Outcome | undefined): string {
  if (o?.kind === 'report') return o.text
  if (o?.kind === 'pr') return `Opened ${o.url}${o.ready ? '' : ' as a draft'}`
  if (o?.kind === 'pushed')
    return `Pushed ${o.commits} ${o.commits === 1 ? 'commit' : 'commits'} onto ${o.url}`
  if (o?.kind === 'review') return `Left your pending review on ${o.url}`
  return ''
}
