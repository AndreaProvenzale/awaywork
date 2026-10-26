import { mkdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { MAX_ATTEMPTS } from '../core/attempts.js'
import { footerItems, hasTrailer, type Left } from '../core/footer.js'
import type { Forge, Unit } from '../core/types.js'
import {
  type Check,
  type CheckOptions,
  checkDetails,
  checkLog,
  commitsSince,
  git,
  type RanCheck,
} from './checks.js'
import { describeFired, gatesSection, runGates, runJudges } from './gates.js'
import { type Outcome, publish, type Stack } from './publish.js'
import { leaveReview } from './review.js'
import {
  outputFile,
  readOutput,
  refuseSymlinks,
  reportsOnly,
  WORK_DIR,
  writeOutput,
} from './workspace.js'

const MAX_SUFFIX = 10

/** A loop of the chain, while its rounds run. */
export interface OpenLoop {
  skills: string[]
  rounds: number
  verdict?: string
  /** The last run of `until`'s command. */
  check?: RanCheck
  ended?: string
  /** Its `until` held. */
  held?: true
}

/** Why a slice's draft waits for a later run: its step asked, its questions on `url`, or said `continue`; and the times its unit said `continue` so far. */
export type Held = Pick<Left, 'status' | 'continued'> & { url?: string }

/** A step's report, and its `out/` as copied to the run dir. */
export type StepReport = { id: string; skill: string; text: string; out: string }

/**
 * The unit's planned branch, else the first of `<branch>-2` to `-10` not on the remote. A taken name
 * whose PR, open or closed unmerged, awaywork opened for one of the unit's items means it tried
 * already (a merged one landed, so the next pickup is a new round and takes a suffix), and
 * one with no PR whose tip has awaywork's trailer is a push whose PR failed: either way the unit
 * is skipped until that branch is deleted, even where no attempts are kept. A branch the chain
 * `published` in this run is only taken; the first one anything else holds comes back as `taken`.
 */
export async function freeBranch(
  forge: Forge,
  unit: Unit,
  published: Set<string>,
): Promise<{ branch: string; taken?: string } | { skip: string }> {
  const items = unit.items.map((i) => `${i.source}:${i.key}`)
  let taken: string | undefined
  for (let n = 1; n <= MAX_SUFFIX; n++) {
    const branch = n === 1 ? unit.branch : `${unit.branch}-${n}`
    if (published.has(branch)) continue
    if (!(await forge.branchExists(unit.repo, branch))) return { branch, taken }
    const prs = await forge.prsOn(unit.repo, branch)
    if (prs.length === 0 && hasTrailer(await forge.tipMessage(unit.repo, branch)))
      return { skip: `${branch} exists on ${unit.repo} without a PR; delete it to run again` }
    const tried = prs.find(
      (pr) => !pr.merged && footerItems(pr.body).some((item) => items.includes(item)),
    )
    if (tried)
      return { skip: `awaywork tried this in ${tried.url}; delete ${branch} to run it again` }
    // A task's PR is found by its branch, so it takes no other name.
    if (unit.items.some((i) => i.task))
      return { skip: `${branch} exists on ${unit.repo}; delete it to run this task` }
    taken ??= branch
  }
  return { skip: `${unit.branch} to ${unit.branch}-${MAX_SUFFIX} already exist on ${unit.repo}` }
}

/**
 * Puts the clone on a new `branch` at its HEAD. Git writes only the branch, HEAD and the index there,
 * each through a lock file it renames, so with the symlinks a worker may plant refused (the index's by
 * restoreGitConfig) and no reflog left to append to, nothing outside the clone is written; no hook or
 * fsmonitor runs.
 */
export async function cutBranch(dir: string, branch: string): Promise<void> {
  await refuseSymlinks(dir, ['.git/HEAD', `.git/refs/heads/${branch}`])
  await rm(join(dir, '.git', 'logs'), { recursive: true, force: true })
  await git(dir, '-c', 'core.logAllRefUpdates=false', 'checkout', '-q', '-b', branch)
}

export interface Publisher {
  forge: Forge
  runId: string
  signal?: AbortSignal
  check: (
    command: string,
    unit: Unit,
    dir: string,
    log: (line: string) => void,
    options?: CheckOptions,
  ) => Promise<Check>
  /** Runs gate `gate`'s judge `skill` on the slice's commits since `from` in the clone, as a step runs; why it didn't run or finish, if so. */
  judge: (
    gate: string,
    skill: string,
    unit: Unit,
    dir: string,
    from: string,
  ) => Promise<string | undefined>
}

/**
 * Publishes a slice's commits since `from` as one PR or push, with its reports; without commits, its reports,
 * the last of them left as a pending review under `deliver: pending_review` unless a step failed or stopped or the run ended before one ran.
 * A `deliver: pr` slice opens as a draft when one of its steps failed or stopped or the run ended before one ran (`failedStep`), a step's status file said `ask` or `continue` (`held`, whose status line then tops the body), its `verify` failed, one of its loops ended before its `until` held or one of its gates fired.
 * On a unit that resumes awaywork's own draft, verify and gates read all of the draft's commits, and it publishes without new ones too.
 * With gates, the PR body, or a push's summary, which goes only in the report, opens with their section: the decision card with each fired gate's line, else the gates that ran.
 * `start` is the commit gates check their scripts against: the clone's before the chain's setup and workers, or where an awaywork PR it took up left the default branch.
 */
export async function publishSlice(
  deps: Publisher,
  unit: Unit,
  dir: string,
  from: string,
  start: string,
  reports: StepReport[],
  loops: Record<number, OpenLoop>,
  stack?: Stack,
  closes = false,
  failedStep?: string,
  held?: Held,
): Promise<Outcome> {
  const { deliver } = unit
  const out = join(dir, WORK_DIR, 'out')
  if (reportsOnly(deliver) || (!unit.resume && (await commitsSince(dir, from)) === 0)) {
    const text = reports.length === 1 ? (reports[0]?.text ?? '') : joinReports(reports)
    if (!text)
      return { kind: 'none', reason: reportsOnly(deliver) ? 'no report written' : 'nothing' }
    await refuseSymlinks(dir, [`${WORK_DIR}/out/${outputFile.report}`])
    await writeOutput(join(out, outputFile.report), `${text}\n`)
    const last = reports.at(-1)
    if (deliver === 'pending_review' && last)
      return failedStep
        ? { kind: 'report', text, unposted: failedStep }
        : leaveReview(deps.forge, unit, from, text, last)
    return { kind: 'report', text }
  }
  await refuseSymlinks(dir, [`${WORK_DIR}/out/${outputFile[deliver]}`])
  await appendChainNotes(join(out, outputFile[deliver]), reports, Object.values(loops))
  const checked = unit.resume?.from ?? from
  const failed = await verify(deps, unit, dir, checked)
  const fired = await runGates(deps.check, unit, dir, checked, start)
  fired.push(...(await runJudges(deps.judge, unit, dir, checked)))
  if (deps.signal?.aborted) return { kind: 'none', reason: 'interrupted', unpublished: true }
  await refuseSymlinks(dir, [`${WORK_DIR}/out/${outputFile[deliver]}`])
  if (unit.gates) {
    const section = gatesSection(Object.keys(unit.gates), fired)
    await prependSection(join(out, outputFile[deliver]), section, deliver !== 'push')
  }
  if (held) {
    const line =
      held.status === 'ask'
        ? `Status: ask${held.url ? `, questions on ${held.url}` : ''}`
        : `Status: continue (${held.continued} of ${MAX_ATTEMPTS}): awaywork's next window run goes on here`
    const section = unit.gates ? line : `${line}\n\n---`
    await prependSection(join(out, outputFile[deliver]), section, deliver !== 'push')
  }
  const unmet = Object.values(loops).find((l) => !l.held)
  // `runLine` splits a chain's cell at `; `.
  const why =
    unmet && `loop ${unmet.skills.join(' ⇄ ')}: ${unmet.ended?.split('; ')[0] ?? 'nothing ran'}`
  const gated = describeFired(fired)
  const said = held && (held.status === 'ask' ? 'asked questions' : 'the agent will continue')
  const notReady = failedStep ?? said ?? failed ?? why ?? gated
  const outcome = await publish(
    unit,
    dir,
    deps.forge,
    deps.runId,
    from,
    stack,
    closes,
    notReady,
    held && { status: held.status, continued: held.continued },
  )
  return outcome.kind === 'pushed' && gated ? { ...outcome, gated } : outcome
}

/** Puts the gates' section first in the PR body, under its title line, or atop a push's summary. */
async function prependSection(file: string, section: string, titled: boolean): Promise<void> {
  const body = (await readOutput(file)).trim()
  if (!body) return
  const cut = titled ? body.indexOf('\n') + 1 || body.length : 0
  const title = titled ? `${body.slice(0, cut).trim()}\n\n` : ''
  await writeOutput(file, `${title}${section}\n\n${body.slice(cut).trim()}\n`)
}

/** Runs the unit's `verify` before it is published, its output in `verify.log`; a failure goes in the PR body, and the unit is still published. Returns how it failed. */
async function verify(
  deps: Publisher,
  unit: Unit,
  dir: string,
  start: string,
): Promise<string | undefined> {
  if (!unit.verify || (await commitsSince(dir, start)) === 0) return
  const ran = {
    command: unit.verify,
    ...(await deps.check(unit.verify, unit, dir, () => {}, { from: start })),
  }
  const out = join(dir, WORK_DIR, 'out')
  await refuseSymlinks(dir, [
    `${WORK_DIR}/out/verify.log`,
    `${WORK_DIR}/out/${outputFile[unit.deliver]}`,
  ])
  await mkdir(out, { recursive: true })
  await writeOutput(join(out, 'verify.log'), checkLog(ran))
  if (!ran.failed) return
  await appendVerifyFailure(join(out, outputFile[unit.deliver]), ran)
  return `verify ${ran.stopped ? 'stopped' : 'failed'}`
}

/** The latest report of each skill: a loop's last review stands for its earlier ones. */
function latestReports(reports: StepReport[]): StepReport[] {
  return reports.filter((r, i) => !reports.slice(i + 1).some((later) => later.skill === r.skill))
}

function joinReports(reports: StepReport[]): string {
  return latestReports(reports)
    .map((r) => `### ${r.id}\n\n${r.text}`)
    .join('\n\n')
}

/** E.g. `2 rounds of review ⇄ fix; until held: verdict approve`. */
export function describeLoop(loop: OpenLoop): string {
  const rounds = `${loop.rounds} ${loop.rounds === 1 ? 'round' : 'rounds'}`
  return `${rounds} of ${loop.skills.join(' ⇄ ')}; ${loop.ended ?? 'nothing ran'}`
}

/** awaywork's own notes in the PR body or push summary: how each loop went, its failing check, and the steps' reports. */
async function appendChainNotes(file: string, reports: StepReport[], loops: OpenLoop[]) {
  const body = (await readOutput(file)).trim()
  if (!body || (reports.length === 0 && loops.length === 0)) return
  const lines = ['', '', '## Awaywork chain']
  for (const loop of loops) {
    const verdict = loop.verdict ? `; last verdict ${loop.verdict}` : ''
    lines.push('', `Loop: ${describeLoop(loop)}${verdict}.`)
    const { check } = loop
    if (check?.failed)
      lines.push(
        '',
        checkDetails(
          `Last check: \`${check.command}\` ${check.stopped ? 'stopped' : 'failed'}`,
          check,
        ),
      )
  }
  for (const r of latestReports(reports))
    lines.push('', `<details><summary>Report: ${r.id}</summary>`, '', r.text, '', '</details>')
  await writeOutput(file, `${body}${lines.join('\n')}\n`)
}

/** Appends a failed `verify` to the PR body or push report, so the reviewer sees it before the diff. */
async function appendVerifyFailure(file: string, check: RanCheck): Promise<void> {
  const body = (await readOutput(file)).trim()
  if (!body) return
  const verb = check.stopped ? 'stopped' : 'failed'
  const summary = `Verify \`${check.command}\` ${verb}: ${check.failed}`
  await writeOutput(file, `${body}\n\n## Awaywork verify\n\n${checkDetails(summary, check)}\n`)
}
