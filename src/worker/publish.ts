import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { execa } from 'execa'
import { trailerKey } from '../core/footer.js'
import type { Forge, Unit } from '../core/types.js'
import { outputFile, readOutput, refuseSymlinks, WORK_DIR, writeOutput } from './workspace.js'

export type Outcome =
  | { kind: 'pr'; url: string; commits: number }
  | { kind: 'report'; text: string }
  | { kind: 'pushed'; branch: string; commits: number; text: string; head: string }
  | { kind: 'none'; reason: string; unpublished?: true }

// No hooks, and history as it is, not as replace refs say.
const safely = ['--no-replace-objects', '-c', 'core.hooksPath=/dev/null']
const git = async (dir: string, ...args: string[]) =>
  (await execa('git', ['-C', dir, ...safely, ...args])).stdout

/**
 * Delivers a finished unit: a draft PR only with commits, a PR body and a branch new to the remote;
 * a push only with commits, a report, and a fast-forward onto the developer's own PR branch.
 * The unit's commits are those after `start`, the commit its clone held before any worker ran.
 * Git reads the clone only to fetch its HEAD into a repo of night-shift's own, so the clone's
 * config, attributes, hooks and refs, which the model can write, neither run nor count here.
 */
export async function publish(
  unit: Unit,
  dir: string,
  forge: Forge,
  runId: string,
  start: string,
): Promise<Outcome> {
  const out = `${WORK_DIR}/out`
  const file = join(dir, out, outputFile[unit.deliver])
  await refuseSymlinks(dir, [`${out}/${outputFile[unit.deliver]}`, `${out}/diff.patch`])
  const text = (await readOutput(file)).trim()
  if (unit.deliver === 'report')
    return text ? { kind: 'report', text } : { kind: 'none', reason: 'no report written' }

  const repo = await mkdtemp(join(tmpdir(), 'nightshift-publish-'))
  try {
    await execa('git', ['init', '-q', '--bare', repo])
    await git(repo, 'fetch', '-q', '--no-tags', dir, 'HEAD:refs/heads/work')
    return await deliver(unit, repo, forge, runId, start, file, text)
  } finally {
    await rm(repo, { recursive: true, force: true })
  }
}

async function deliver(
  unit: Unit,
  repo: string,
  forge: Forge,
  runId: string,
  start: string,
  file: string,
  text: string,
): Promise<Outcome> {
  const push = unit.deliver === 'push'
  const log = await git(repo, 'rev-list', '--topo-order', '--reverse', 'work', `^${start}`)
  const commits = log.split('\n').filter(Boolean)
  const oldest = commits[0]
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
  // Merged history would carry other people's commits onto the PR, with night-shift's trailer.
  if (push && (await git(repo, 'rev-list', '--merges', 'work', `^${start}`)))
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

  const head = await withTrailer(repo, commits, `${trailerKey}: ${runId}`)
  await git(repo, 'update-ref', 'HEAD', head)
  await writeOutput(
    join(dirname(file), 'diff.patch'),
    `${await git(repo, 'diff', '--no-ext-diff', '--no-textconv', `${oldest}^`, head)}\n`,
  )
  if (push && pr) {
    // The forge refuses unless the PR's head is still `start`.
    await forge.fastForward(repo, unit.base, start, { repo: unit.repo, pr: pr.number })
    return { kind: 'pushed', branch: unit.base, commits: commits.length, text, head }
  }
  await forge.push(repo, unit.branch, { repo: unit.repo })
  if (unit.stackedOn)
    await writeOutput(file, `\n\nStacked on ${unit.stackedOn}: merge that first.\n`, true)
  const url = await forge.draftPr(unit.repo, unit.branch, unit.base, file, runId)
  return { kind: 'pr', url, commits: commits.length }
}

/** Rewrites `commits`, oldest first, each with `trailer` and its author kept; returns the new tip. */
async function withTrailer(repo: string, commits: string[], trailer: string): Promise<string> {
  const fresh = new Map<string, string>()
  for (const sha of commits) {
    const meta = await git(repo, 'log', '-1', '--format=%T%n%P%n%an%n%ae%n%ad', '--date=raw', sha)
    const [tree = '', parents = '', name, email, date] = meta.split('\n')
    const message = await git(repo, 'log', '-1', '--format=%B', sha)
    const input = (
      await execa('git', ['-C', repo, 'interpret-trailers', '--no-divider', '--trailer', trailer], {
        input: message,
      })
    ).stdout
    const onto = parents
      .split(' ')
      .filter(Boolean)
      .flatMap((p) => ['-p', fresh.get(p) ?? p])
    const env = { GIT_AUTHOR_NAME: name, GIT_AUTHOR_EMAIL: email, GIT_AUTHOR_DATE: date }
    const made = await execa('git', ['-C', repo, ...safely, 'commit-tree', tree, ...onto], {
      input,
      env,
    })
    fresh.set(sha, made.stdout)
  }
  return fresh.get(commits.at(-1) ?? '') ?? ''
}
