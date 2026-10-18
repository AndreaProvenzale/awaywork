import { mkdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { footerItems, hasTrailer } from '../core/footer.js'
import type { Forge, Unit } from '../core/types.js'
import { type Check, checkDetails, checkLog, commitsSince, git, type RanCheck } from './checks.js'
import { type Outcome, publish, type Stack } from './publish.js'
import { outputFile, readOutput, refuseSymlinks, WORK_DIR, writeOutput } from './workspace.js'

const MAX_SUFFIX = 10

/** A loop of the chain, while its rounds run. */
export interface OpenLoop {
  skills: string[]
  rounds: number
  verdict?: string
  /** The last run of `until`'s command. */
  check?: RanCheck
  ended?: string
}

export type StepReport = { id: string; skill: string; text: string }

/**
 * The unit's planned branch, else the first of `<branch>-2` to `-10` not on the remote. A taken name
 * whose PR, open or closed unmerged, awaywork opened for one of the unit's items means it tried
 * already (a merged one landed, so the next pickup is a new round and takes a suffix), and
 * one with no PR whose tip has awaywork's trailer is a push whose PR failed: either way the unit
 * is skipped until that branch is deleted, even where no attempts are kept. A branch the chain
 * `published` in this run is only taken.
 */
export async function freeBranch(
  forge: Forge,
  unit: Unit,
  published: Set<string>,
): Promise<{ branch: string } | { skip: string }> {
  const items = unit.items.map((i) => `${i.source}:${i.key}`)
  for (let n = 1; n <= MAX_SUFFIX; n++) {
    const branch = n === 1 ? unit.branch : `${unit.branch}-${n}`
    if (published.has(branch)) continue
    if (!(await forge.branchExists(unit.repo, branch))) return { branch }
    const prs = await forge.prsOn(unit.repo, branch)
    if (prs.length === 0 && hasTrailer(await forge.tipMessage(unit.repo, branch)))
      return { skip: `${branch} exists on ${unit.repo} without a PR; delete it to run again` }
    const tried = prs.find(
      (pr) => !pr.merged && footerItems(pr.body).some((item) => items.includes(item)),
    )
    if (tried)
      return { skip: `awaywork tried this in ${tried.url}; delete ${branch} to run it again` }
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
  const off = ['core.hooksPath=/dev/null', 'core.fsmonitor=false', 'core.logAllRefUpdates=false']
  await git(dir, ...off.flatMap((c) => ['-c', c]), 'checkout', '-q', '-b', branch)
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
    published: boolean,
  ) => Promise<Check>
}

/** Publishes a slice's commits since `from` as one draft PR or push, with its reports; without commits, its reports. */
export async function publishSlice(
  deps: Publisher,
  unit: Unit,
  dir: string,
  from: string,
  reports: StepReport[],
  loops: Record<number, OpenLoop>,
  stack?: Stack,
): Promise<Outcome> {
  const { deliver } = unit
  const out = join(dir, WORK_DIR, 'out')
  if (deliver === 'report' || (await commitsSince(dir, from)) === 0) {
    const text = reports.length === 1 ? (reports[0]?.text ?? '') : joinReports(reports)
    if (!text)
      return { kind: 'none', reason: deliver === 'report' ? 'no report written' : 'no commits' }
    await refuseSymlinks(dir, [`${WORK_DIR}/out/${outputFile.report}`])
    await writeOutput(join(out, outputFile.report), `${text}\n`)
    return { kind: 'report', text }
  }
  await refuseSymlinks(dir, [`${WORK_DIR}/out/${outputFile[deliver]}`])
  await appendChainNotes(join(out, outputFile[deliver]), reports, Object.values(loops))
  await verify(deps, unit, dir, from)
  if (deps.signal?.aborted) return { kind: 'none', reason: 'interrupted', unpublished: true }
  return publish(unit, dir, deps.forge, deps.runId, from, stack)
}

/** Runs the unit's `verify` before it is published, its output in `verify.log`; a failure goes in the PR body, and the unit is still published. */
async function verify(deps: Publisher, unit: Unit, dir: string, start: string) {
  if (!unit.verify || (await commitsSince(dir, start)) === 0) return
  const ran = {
    command: unit.verify,
    ...(await deps.check(unit.verify, unit, dir, () => {}, false)),
  }
  const out = join(dir, WORK_DIR, 'out')
  await refuseSymlinks(dir, [
    `${WORK_DIR}/out/verify.log`,
    `${WORK_DIR}/out/${outputFile[unit.deliver]}`,
  ])
  await mkdir(out, { recursive: true })
  await writeOutput(join(out, 'verify.log'), checkLog(ran))
  if (ran.failed) await appendVerifyFailure(join(out, outputFile[unit.deliver]), ran)
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
