import { cp, mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { execa } from 'execa'
import { bin } from '../config/paths.js'
import { git } from './checks.js'
import { commandEnv, inClone, readOutput, refuseSymlinks, WORK_DIR } from './workspace.js'

export function isLast(loop: {
  round: number
  max: number
  step: number
  skills: string[]
}): boolean {
  return loop.round === loop.max && loop.step === loop.skills.length - 1
}

export function maxReached(max: number): string {
  return `max ${max} ${max === 1 ? 'round' : 'rounds'} reached`
}

/** The one lowercase word a skill wrote to `out/verdict`, if any. */
export async function readVerdict(dir: string): Promise<string | undefined> {
  const text = await readOutput(join(dir, WORK_DIR, 'out', 'verdict'))
  const word = text.trim().toLowerCase()
  return /^[a-z][a-z_-]*$/.test(word) ? word : undefined
}

/** What a step left for the chain, e.g. `2 commits and a report`. */
export function made(commits: number, report: string): string {
  const parts = [
    commits > 0 && `${commits} ${commits === 1 ? 'commit' : 'commits'}`,
    report && 'a report',
  ].filter(Boolean)
  return parts.length ? parts.join(' and ') : 'nothing'
}

/** Saves a step's own commits for the next, and clears what only it wrote from the shared clone. */
export async function handOff(dir: string, start: string, unitDir: string): Promise<void> {
  const diff = await git(dir, 'diff', '--no-ext-diff', '--no-textconv', start, 'HEAD')
  // A round that cleaned the clone left no `out/` to copy.
  await mkdir(join(unitDir, 'out'), { recursive: true })
  if (diff) await writeFile(join(unitDir, 'out', 'diff.patch'), `${diff}\n`)
  await refuseSymlinks(dir, [`${WORK_DIR}/out`])
  const out = join(dir, WORK_DIR, 'out')
  await Promise.all(
    ['report.md', 'review.json', 'verdict', 'check.log'].map((f) =>
      rm(join(out, f), { force: true }),
    ),
  )
}

/** A clone as a step found it, as git trees: what it staged, and its working tree with `out/`. */
export interface Snapshot {
  staged: string
  tree: string
}

/** The clone for `discard` to put back; none while a conflicted merge leaves its index no tree. */
export async function snapshot(dir: string): Promise<Snapshot | undefined> {
  const staged = await git(dir, 'write-tree').catch(() => undefined)
  if (!staged) return undefined
  const index = join(dir, '.git', 'away-snapshot')
  const run = async (...args: string[]) =>
    (
      await execa(bin('git'), [...inClone(dir), ...args], {
        env: { GIT_INDEX_FILE: index },
      })
    ).stdout
  try {
    // Starting from the clone's index spares hashing every unchanged file again.
    await cp(join(dir, '.git', 'index'), index)
    // `add` runs git in each submodule, under its config, which repo code may have written.
    // Paths as bytes on stdin: a name needn't be UTF-8.
    const listed = await execa(bin('git'), [...inClone(dir), 'ls-files', '-z', '--stage'], {
      env: { GIT_INDEX_FILE: index },
      encoding: 'buffer',
    })
    const gitlinks = Buffer.from(listed.stdout)
      .toString('latin1')
      .split('\0')
      .filter((entry) => entry.startsWith('160000 '))
      .map((entry) => `:(exclude,literal)${entry.slice(entry.indexOf('\t') + 1)}\0`)
    const add = (flag: string, pathspec: string) =>
      execa(
        bin('git'),
        [...inClone(dir), 'add', flag, '--pathspec-from-file=-', '--pathspec-file-nul'],
        {
          env: { GIT_INDEX_FILE: index },
          input: Buffer.from([`${pathspec}\0`, ...gitlinks].join(''), 'latin1'),
        },
      )
    await add('-A', '.')
    await add('-f', `${WORK_DIR}/out`)
    return { staged, tree: await run('write-tree') }
  } finally {
    await rm(index, { force: true })
  }
}

/** Puts the clone back exactly as a failed step found it: at its `start` commit, with `snapshot`'s trees. */
export async function discard(dir: string, start: string, saved: Snapshot): Promise<void> {
  await rm(join(dir, WORK_DIR, 'out'), { recursive: true, force: true })
  await git(dir, 'reset', '-q', '--hard', start)
  await git(dir, 'clean', '-q', '-fd')
  await git(dir, 'read-tree', '-u', '--reset', saved.tree)
  await git(dir, 'read-tree', saved.staged)
}

/** With every secret withheld except the repo's own. */
export function setupEnv(
  env: NodeJS.ProcessEnv,
  dir: string,
  secrets: string[],
  own: string[],
): NodeJS.ProcessEnv {
  const passed = own.filter((name) => env[name] !== undefined).map((name) => [name, env[name]])
  return { ...commandEnv(env, dir, secrets), ...Object.fromEntries(passed) }
}
