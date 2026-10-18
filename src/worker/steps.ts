import { mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { git } from './checks.js'
import { commandEnv, readOutput, refuseSymlinks, WORK_DIR } from './workspace.js'

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
