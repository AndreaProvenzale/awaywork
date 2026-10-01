import { appendFile, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { execa } from 'execa'
import type { Forge, Unit } from '../core/types.js'
import { outputFile, WORK_DIR } from './workspace.js'

export type Outcome =
  | { kind: 'pr'; url: string; commits: number }
  | { kind: 'report'; text: string }
  | { kind: 'pushed'; branch: string; commits: number; text: string }
  | { kind: 'none'; reason: string; unpublished?: true }

// No hooks, and history as it is, not as the clone's replace refs say.
const safely = ['--no-replace-objects', '-c', 'core.hooksPath=/dev/null']
const git = async (dir: string, ...args: string[]) =>
  (await execa('git', ['-C', dir, ...safely, ...args])).stdout

/**
 * Delivers a finished unit: a draft PR only with commits, a PR body and a branch new to the remote;
 * a push only with commits, a report, and a fast-forward onto the developer's own PR branch.
 */
export async function publish(
  unit: Unit,
  dir: string,
  forge: Forge,
  runId: string,
): Promise<Outcome> {
  const file = join(dir, WORK_DIR, 'out', outputFile[unit.deliver])
  const text = (await readFile(file, 'utf8').catch(() => '')).trim()
  if (unit.deliver === 'report')
    return text ? { kind: 'report', text } : { kind: 'none', reason: 'no report written' }

  const push = unit.deliver === 'push'
  // The forge checks the PR's head is still `from`, so the range doesn't trust the clone's other refs.
  const from =
    push && unit.base ? await git(dir, 'rev-parse', `refs/remotes/origin/${unit.base}`) : undefined
  const since = from ? [`^${from}`] : ['--not', '--remotes']
  const log = await git(dir, 'rev-list', 'HEAD', ...since)
  const commits = log.split('\n').filter(Boolean)
  const oldest = commits.at(-1)
  if (!oldest) return { kind: 'none', reason: 'no commits' }
  if (!text)
    return {
      kind: 'none',
      reason: `${commits.length} commits but no ${push ? 'report' : 'PR body'}, not pushed`,
      unpublished: true,
    }
  const pr = unit.items
    .flatMap((i) => i.linkedPrs)
    .find((p) => p.repo === unit.repo && p.branch === unit.base)
  if (push && (!pr || unit.foreign))
    return {
      kind: 'none',
      reason: `push goes only onto your own PR's branch, not pushed`,
      unpublished: true,
    }
  // The trailer rebase would flatten a merge, replaying the merged branch's commits as night-shift's.
  if (push && (await git(dir, 'rev-list', '--merges', 'HEAD', ...since)))
    return {
      kind: 'none',
      reason: `${commits.length} commits include a merge, not pushed`,
      unpublished: true,
    }
  if (!push && (await forge.branchExists(unit.repo, unit.branch)))
    return {
      kind: 'none',
      reason: `${unit.branch} already exists on ${unit.repo}, not pushed`,
      unpublished: true,
    }

  const trailer = `git commit -q --amend --no-edit --no-verify --trailer 'Night-shift: ${runId}'`
  await git(dir, 'rebase', '-q', '--exec', trailer, `${oldest}^`)
  await writeFile(
    join(dir, WORK_DIR, 'out', 'diff.patch'),
    `${await git(dir, 'diff', `${oldest}^`)}\n`,
  )
  if (pr && from) {
    await forge.fastForward(dir, unit.base, from, { repo: unit.repo, pr: pr.number })
    return { kind: 'pushed', branch: unit.base, commits: commits.length, text }
  }
  await forge.push(dir, unit.branch, { repo: unit.repo })
  if (unit.stackedOn)
    await appendFile(file, `\n\nStacked on ${unit.stackedOn}: merge that first.\n`)
  const url = await forge.draftPr(unit.repo, unit.branch, unit.base, file, runId)
  return { kind: 'pr', url, commits: commits.length }
}
