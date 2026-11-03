import { cp, mkdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { execa } from 'execa'
import { bin } from '../config/paths.js'
import { counted } from '../core/report.js'
import { git } from './checks.js'
import { addTo } from './steps.js'
import { inClone, outputFile, WORK_DIR, writeOutput } from './workspace.js'

/** What awaywork's own merge of a PR's base did: made the merge `commit`, stopped on conflicting `paths` of the base at `head`, or found nothing to merge. */
export type Merge =
  | { kind: 'merged'; commit: string; commits: number }
  | { kind: 'conflicts'; paths: string[]; head: string; commits: number }
  | { kind: 'current' }

/** A merge awaywork left conflicted for a worker on the clone's `start`: the base `into` at `head`, its conflicted `paths`, and `automatic`, git's own merge of them as a local commit. */
export interface Resolving {
  start: string
  into: string
  head: string
  commits: number
  paths: string[]
  automatic: string
}

/** The context file listing a merge's conflicts, for the worker. */
export const conflictsFile = join(WORK_DIR, 'context', 'merge.md')

const run = (dir: string, env: NodeJS.ProcessEnv, args: string[], input?: string) =>
  execa(bin('git'), [...inClone(dir), ...args], { env, extendEnv: false, input })

const literal = (paths: string[]) => paths.map((p) => `:(literal)${p}`)

/**
 * Merges `origin/<into>`, as the clone fetched it, into its branch `branch`, as a merge commit made with
 * `env`'s git config; one that conflicts is aborted, unless `keep` leaves it in the working tree. A clean one leaves its summary in `pr.md`.
 */
export async function mergeBase(
  dir: string,
  into: string,
  branch: string,
  env: NodeJS.ProcessEnv,
  log: (line: string) => void,
  keep = false,
): Promise<Merge> {
  const head = await git(
    dir,
    'rev-parse',
    '--verify',
    `refs/remotes/origin/${into}^{commit}`,
  ).catch(() => {
    throw new Error(`base ${into} is gone: nothing to merge`)
  })
  const commits = Number(await git(dir, 'rev-list', '--count', head, '^HEAD'))
  if (commits === 0) return { kind: 'current' }
  const message = `Merge ${into} into ${branch}`
  const merge = await execa(
    bin('git'),
    [...inClone(dir), 'merge', '--no-ff', '--no-edit', '-m', message, head],
    { env, extendEnv: false, reject: false, all: true },
  )
  log(`git merge ${into} (${head.slice(0, 7)}): exit ${merge.exitCode}\n${merge.all}`)
  if (merge.exitCode === 0) {
    const summary = `${message}: ${counted(commits, 'commit')}, ${into} at ${head.slice(0, 7)}.`
    await writeOutput(join(dir, WORK_DIR, 'out', outputFile.push), `${summary}\n`)
    return { kind: 'merged', commit: await git(dir, 'rev-parse', 'HEAD'), commits }
  }
  const paths = (await git(dir, 'diff', '--name-only', '--diff-filter=U'))
    .split('\n')
    .filter(Boolean)
  if (paths.length === 0) throw new Error(`git merge ${into} failed: ${merge.all}`)
  if (!keep) await git(dir, 'merge', '--abort')
  return { kind: 'conflicts', paths, head, commits }
}

/**
 * Before any worker or repo code runs: keeps git's automatic merge, markers included, as a commit on the clone's
 * HEAD that is never pushed, and lists the conflicted paths and the base's commits touching them for the worker.
 */
export async function leaveConflicts(
  dir: string,
  merge: Extract<Merge, { kind: 'conflicts' }>,
  into: string,
  branch: string,
  env: NodeJS.ProcessEnv,
): Promise<Resolving> {
  const start = await git(dir, 'rev-parse', 'HEAD')
  // The index git's merge just wrote holds the base's new files, ignored or not.
  const tree = await worktreeTree(dir, env, '-A', (index) => cp(join(dir, '.git', 'index'), index))
  const automatic = await commitTree(dir, env, tree, [start], `git's automatic merge of ${into}`)
  const touching = await git(
    dir,
    'log',
    '--max-count=100',
    '--format=- %h %s',
    merge.head,
    `^${start}`,
    '--',
    ...literal(merge.paths),
  )
  await mkdir(join(dir, WORK_DIR, 'context'), { recursive: true })
  await writeOutput(
    join(dir, conflictsFile),
    [
      `awaywork merged \`${into}\` (at ${merge.head.slice(0, 7)}, ${counted(merge.commits, 'commit')}) into \`${branch}\`, and these files conflict:`,
      '',
      ...merge.paths.map((p) => `- ${p}`),
      '',
      `The commits on \`${into}\` that touch them, newest first:`,
      '',
      touching,
      '',
    ].join('\n'),
  )
  return { start, into, head: merge.head, commits: merge.commits, paths: merge.paths, automatic }
}

/**
 * Makes the merge a worker resolved: the files of git's automatic merge as its working tree holds them, `.away/`
 * left out, committed on exactly the clone's start and the base's head, whatever `.git` says now; it lists the
 * untracked files it left out. Refused while a conflicted path holds a conflict marker, or when nothing of the base came in.
 */
export async function concludeMerge(
  dir: string,
  r: Resolving,
  branch: string,
  env: NodeJS.ProcessEnv,
): Promise<{ commit: string; untracked: string[] } | { refused: string }> {
  let untracked: string[] = []
  const tree = await worktreeTree(dir, env, '-u', async (index) => {
    const staging = { ...env, GIT_INDEX_FILE: index }
    await run(dir, staging, ['read-tree', r.automatic])
    const others = [
      'ls-files',
      '-z',
      '-o',
      '--exclude-standard',
      '--directory',
      '--no-empty-directory',
    ]
    untracked = (await run(dir, staging, others)).stdout
      .split('\0')
      .filter((p) => p && !`${p}/`.startsWith(`${WORK_DIR}/`))
  })
  if (tree === (await git(dir, 'rev-parse', `${r.start}^{tree}`)))
    return { refused: `the resolution keeps nothing of ${r.into}, not pushed` }
  // As text, whatever attributes the worker wrote say; `conflict-marker-size` makes markers longer.
  const marker = ['grep', '-a', '-l', '-E', '^(<{7,}|>{7,})( |$)', tree, '--', ...literal(r.paths)]
  const grep = await execa(bin('git'), [...inClone(dir), ...marker], {
    env,
    extendEnv: false,
    reject: false,
  })
  if (grep.exitCode !== 0 && grep.exitCode !== 1) throw new Error(`git grep failed: ${grep.stderr}`)
  const markers = grep.stdout
    .split('\n')
    .filter(Boolean)
    .map((line) => line.slice(tree.length + 1))
  if (markers.length)
    return { refused: `conflict markers left in ${markers.join(', ')}, not pushed` }
  const message = `Merge ${r.into} into ${branch}`
  const commit = await commitTree(dir, env, tree, [r.start, r.head], message)
  await run(dir, env, ['reset', '-q', commit])
  return { commit, untracked }
}

/** The clone's working tree as a tree, `git add <flag>`ed on what `seed` puts in a fresh index of awaywork's, `.away/` left out. */
async function worktreeTree(
  dir: string,
  env: NodeJS.ProcessEnv,
  flag: '-A' | '-u',
  seed: (index: string) => Promise<unknown>,
): Promise<string> {
  const index = join(dir, '.git', 'away-merge-index')
  await rm(index, { force: true })
  try {
    const staging = { ...env, GIT_INDEX_FILE: index }
    await seed(index)
    await addTo(dir, index, flag, ['.'], env)
    // Git ignores `.away/` through `.git/info/exclude`, which the worker could edit.
    await run(dir, staging, ['rm', '-r', '-q', '--cached', '--ignore-unmatch', '--', WORK_DIR])
    return (await run(dir, staging, ['write-tree'])).stdout
  } finally {
    await rm(index, { force: true })
  }
}

async function commitTree(
  dir: string,
  env: NodeJS.ProcessEnv,
  tree: string,
  parents: string[],
  message: string,
): Promise<string> {
  const args = ['commit-tree', tree, ...parents.flatMap((p) => ['-p', p])]
  return (await run(dir, env, args, message)).stdout
}
