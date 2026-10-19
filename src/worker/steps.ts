import { cp, mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { execa } from 'execa'
import { bin } from '../config/paths.js'
import { git } from './checks.js'
import { commandEnv, readOutput, refuseSymlinks, WORK_DIR } from './workspace.js'

const off = ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false']

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
    ['report.md', 'verdict', 'check.log'].map((f) => rm(join(out, f), { force: true })),
  )
}

/** The clone's working tree and `out/` as a git tree, for `discard` to put back. */
export async function snapshot(dir: string): Promise<string> {
  const index = join(dir, '.git', 'away-snapshot')
  const run = async (...args: string[]) =>
    (await execa(bin('git'), ['-C', dir, ...off, ...args], { env: { GIT_INDEX_FILE: index } }))
      .stdout
  try {
    // Starting from the clone's index spares hashing every unchanged file again.
    await cp(join(dir, '.git', 'index'), index)
    await run('add', '-A')
    await run('add', '-f', '--', `${WORK_DIR}/out`)
    return await run('write-tree')
  } finally {
    await rm(index, { force: true })
  }
}

/** Puts the clone back exactly as a failed step found it: at its `start` commit, with `snapshot`'s tree. */
export async function discard(dir: string, start: string, tree: string): Promise<void> {
  await rm(join(dir, WORK_DIR, 'out'), { recursive: true, force: true })
  await git(dir, ...off, 'reset', '-q', '--hard', start)
  await git(dir, ...off, 'clean', '-q', '-fd')
  await git(dir, ...off, 'read-tree', '-u', '--reset', tree)
  await git(dir, ...off, 'reset', '-q')
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
