import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { execa } from 'execa'
import { bin } from '../config/paths.js'
import { type Status, trailerKey } from '../core/footer.js'
import { counted } from '../core/report.js'
import type { Forge, Unit } from '../core/types.js'
import { outputFile, readOutput, refuseSymlinks, WORK_DIR, writeOutput } from './workspace.js'

export type Outcome =
  | {
      kind: 'pr'
      url: string
      commits: number
      head: string
      /** Opened ready for review; a PR without it is a draft. */
      ready?: true
      /** Why a `deliver: pr` PR opened as a draft. */
      draft?: string
    }
  | {
      kind: 'report'
      text: string
      /** Why a `deliver: pending_review` report wasn't left as a review. */
      unposted?: string
    }
  | {
      kind: 'review'
      url: string
      text: string
      /** Why its line comments were left out. */
      note?: string
    }
  | {
      kind: 'pushed'
      branch: string
      url: string
      commits: number
      text: string
      head: string
      /** Which gates fired: their card tops `text`, which reaches only the report. */
      gated?: string
    }
  | { kind: 'none'; reason: string; unpublished?: true }

/** A chain's own repo, kept across its slices, and the tip the slice before pushed in place of the clone's `start`. */
export interface Stack {
  repo: string
  onto?: string
}

// No hooks, and history as it is, not as replace refs say.
const safely = ['--no-replace-objects', '-c', 'core.hooksPath=/dev/null']
const git = async (dir: string, ...args: string[]) =>
  (await execa(bin('git'), ['-C', dir, ...safely, ...args])).stdout

/**
 * Delivers a finished unit: a PR only with commits, a PR body and a branch new to the remote, a draft
 * unless it's `deliver: pr` and nothing left it `notReady`, its footer recording the `status` its step said;
 * a push only with commits, a summary in `pr.md`, and a fast-forward onto the developer's own PR branch.
 * The unit's commits are those after `start`, the commit its clone held before any worker ran.
 * Git reads the clone only to fetch its HEAD into a repo of awaywork's own, so the clone's
 * config, attributes, hooks and refs, which the model can write, neither run nor count here.
 * A chain's later slice publishes from the chain's `stack` repo, onto the tip the slice before pushed.
 */
export async function publish(
  unit: Unit,
  dir: string,
  forge: Forge,
  runId: string,
  start: string,
  stack?: Stack,
  closes = false,
  notReady?: string,
  status?: Status,
): Promise<Outcome> {
  const out = `${WORK_DIR}/out`
  const file = join(dir, out, outputFile[unit.deliver])
  await refuseSymlinks(dir, [`${out}/${outputFile[unit.deliver]}`, `${out}/diff.patch`])
  const text = (await readOutput(file)).trim()
  if (unit.deliver === 'report')
    return text ? { kind: 'report', text } : { kind: 'none', reason: 'no report written' }

  const repo = stack?.repo ?? (await mkdtemp(join(tmpdir(), 'awaywork-publish-')))
  try {
    await execa(bin('git'), ['init', '-q', '--bare', repo])
    // From the clone's own `.git` only, like `inClone`.
    const strict = '--upload-pack=git-upload-pack --strict'
    await git(repo, 'fetch', '-q', '--no-tags', strict, join(dir, '.git'), '+HEAD:refs/heads/work')
    return await deliver(
      unit,
      repo,
      forge,
      runId,
      start,
      file,
      text,
      stack?.onto,
      closes,
      notReady,
      status,
    )
  } finally {
    if (!stack) await rm(repo, { recursive: true, force: true })
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
  onto?: string,
  closes = false,
  notReady?: string,
  status?: Status,
): Promise<Outcome> {
  const push = unit.deliver === 'push'
  // The harness forbids rebasing: a branch that dropped `start` holds work that isn't the unit's alone.
  const holds = await git(repo, 'merge-base', '--is-ancestor', start, 'work').then(
    () => true,
    () => false,
  )
  if (!holds)
    return {
      kind: 'none',
      reason: `the branch no longer holds ${start.slice(0, 7)}, where the clone started, not pushed`,
      unpublished: true,
    }
  const log = await git(repo, 'rev-list', '--topo-order', '--reverse', 'work', `^${start}`)
  const commits = log.split('\n').filter(Boolean)
  const oldest = commits[0]
  if (!oldest) return { kind: 'none', reason: 'nothing' }
  if (!text)
    return {
      kind: 'none',
      reason: `${counted(commits.length, 'commit')} but no ${push ? 'summary' : 'PR body'}, not pushed`,
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
  // Merged history would carry other people's commits onto the PR, with awaywork's trailer.
  if (await git(repo, 'rev-list', '--merges', 'work', `^${start}`))
    return {
      kind: 'none',
      reason: `${counted(commits.length, 'commit')} include a merge, not pushed`,
      unpublished: true,
    }
  if (!push && (await forge.branchExists(unit.repo, unit.branch)))
    return {
      kind: 'none',
      reason: `${unit.branch} already exists on ${unit.repo}, not pushed`,
      unpublished: true,
    }

  const head = await withTrailer(
    repo,
    commits,
    `${trailerKey}: ${runId}`,
    new Map(onto ? [[start, onto]] : []),
  )
  await git(repo, 'update-ref', 'HEAD', head)
  await writeOutput(
    join(dirname(file), 'diff.patch'),
    `${await git(repo, 'diff', '--no-ext-diff', '--no-textconv', `${oldest}^`, head)}\n`,
  )
  if (push && pr) {
    // The forge refuses unless the PR's head is still `start`.
    const refused = await forge.fastForward(repo, unit.base, start, {
      repo: unit.repo,
      pr: pr.number,
    })
    if (refused) return { kind: 'none', reason: `${refused}, not pushed`, unpublished: true }
    return { kind: 'pushed', branch: unit.base, url: pr.url, commits: commits.length, text, head }
  }
  await forge.push(repo, unit.branch, { repo: unit.repo })
  // The items' link lines let their trackers link the PR, whatever its branch is called.
  const notes = [...new Set(unit.items.flatMap((i) => i.link ?? []))]
  // GitHub closes an issue when the last slice merges into the default branch, after the retarget.
  if (closes)
    for (const i of unit.items)
      if (i.source === 'github' && i.type === 'issue') notes.push(`Closes ${i.key}`)
  if (unit.stackedOn) notes.push(`Stacked on ${unit.stackedOn}: merge that first.`)
  if (notes.length) await writeOutput(file, `\n\n${notes.join('\n\n')}\n`, true)
  const ready = unit.deliver === 'pr' && !notReady
  const url = await forge.openPr(
    unit.repo,
    unit.branch,
    unit.base,
    file,
    runId,
    unit.items,
    !ready,
    status,
  )
  // Stacked PRs are a preview on GitHub: a repo without them answers 404, and the body says it anyway.
  if (unit.stackedOn) await forge.stack(unit.repo, unit.stackedOn, url).catch(() => {})
  const opened = ready ? { ready } : unit.deliver === 'pr' ? { draft: notReady } : {}
  return { kind: 'pr', url, commits: commits.length, head, ...opened }
}

/**
 * Rewrites `commits`, oldest first, each with `trailer` and its author and committer kept, onto the
 * parents `fresh` already maps, such as the slice before's tip to its pushed one; returns the new tip.
 */
async function withTrailer(
  repo: string,
  commits: string[],
  trailer: string,
  fresh: Map<string, string>,
): Promise<string> {
  for (const sha of commits) {
    const format = '--format=%T%n%P%n%an%n%ae%n%ad%n%cn%n%ce%n%cd'
    const meta = await git(repo, 'log', '-1', format, '--date=raw', sha)
    const [tree = '', parents = '', name, email, date, cname, cemail, cdate] = meta.split('\n')
    const message = await git(repo, 'log', '-1', '--format=%B', sha)
    const input = (
      await execa(
        bin('git'),
        ['-C', repo, 'interpret-trailers', '--no-divider', '--trailer', trailer],
        { input: message },
      )
    ).stdout
    const onto = parents
      .split(' ')
      .filter(Boolean)
      .flatMap((p) => ['-p', fresh.get(p) ?? p])
    const env = {
      GIT_AUTHOR_NAME: name,
      GIT_AUTHOR_EMAIL: email,
      GIT_AUTHOR_DATE: date,
      GIT_COMMITTER_NAME: cname,
      GIT_COMMITTER_EMAIL: cemail,
      GIT_COMMITTER_DATE: cdate,
    }
    const made = await execa(bin('git'), ['-C', repo, ...safely, 'commit-tree', tree, ...onto], {
      input,
      env,
    })
    fresh.set(sha, made.stdout)
  }
  return fresh.get(commits.at(-1) ?? '') ?? ''
}
