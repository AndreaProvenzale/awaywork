import { join } from 'node:path'
import { execa } from 'execa'
import { bin } from '../config/paths.js'
import { counted } from '../core/report.js'
import { git } from './checks.js'
import { inClone, outputFile, WORK_DIR, writeOutput } from './workspace.js'

/** What awaywork's own merge of a PR's base did: made the merge `commit`, stopped on conflicting `paths`, or found nothing to merge. */
export type Merge =
  | { kind: 'merged'; commit: string; commits: number }
  | { kind: 'conflicts'; paths: string[] }
  | { kind: 'current' }

/**
 * Merges `origin/<into>`, as the clone fetched it, into its branch `branch`, as a merge commit made with
 * `env`'s git config; one that conflicts is aborted. A clean one leaves its summary in `pr.md`.
 */
export async function mergeBase(
  dir: string,
  into: string,
  branch: string,
  env: NodeJS.ProcessEnv,
  log: (line: string) => void,
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
  await git(dir, 'merge', '--abort')
  return { kind: 'conflicts', paths }
}
