import { mkdir } from 'node:fs/promises'
import { dirname, relative } from 'node:path'
import { execa } from 'execa'
import { bin } from '../config/paths.js'
import { type Facts, holds } from '../core/condition.js'
import type { Condition, Unit } from '../core/types.js'
import { runCommand } from './setup.js'
import { checkEnv, inClone, refuseSymlinks, restoreGitConfig, writeOutput } from './workspace.js'

const CHECK_LOG_CHARS = 8000

export interface Check {
  output: string
  /** The command's own stdout, without stderr, when it ran. */
  stdout?: string
  failed?: string
  /** Cut short by Ctrl-C or the window's end: the condition is unknown, not false. */
  stopped?: true
  /** Hit the time limit: a `when` can't tell it from a negated check that passed, so it isn't false either. */
  timedOut?: true
  /** Never runs on this unit: a `when` on it doesn't hold, and an `until` can't. */
  refused?: true
}

export type RanCheck = Check & { command: string }

export interface CheckOptions {
  /** The slice's base, the command's `AWAYWORK_FROM`. */
  from?: string
  /** It decides what is published (`until`): files left uncommitted fail it. */
  published?: boolean
  /** Runs it even when this commit's result is known, and keeps nothing: a gate judges the script as it is now. */
  fresh?: boolean
}

export interface ChecksInput {
  env: NodeJS.ProcessEnv
  secrets: string[]
  signal?: AbortSignal
  until?: Date
}

/** The command checks of a run, with the baselines and git configs of the clones they share. */
export function createChecks(input: ChecksInput) {
  const checks = new Map<string, Check>()
  // What each clone had uncommitted before a worker could leave anything: setup's and the checks' leftovers.
  const baselines = new Map<string, Set<string>>()
  // Each clone's git config as cloned, put back after anything ran the worker's code in it.
  const gitConfigs = new Map<string, string>()
  const restoreGit = (dir: string) => restoreGitConfig(dir, gitConfigs.get(dir) ?? '')
  const rememberGitConfig = (dir: string, config: string) => gitConfigs.set(dir, config)
  const baseline = async (dir: string) => {
    baselines.set(dir, new Set(await uncommitted(dir)))
  }

  /**
   * Runs a condition's command in the clone outside the model, once per commit, with none of the
   * secrets, and git reading history as it is, not as the clone's replace refs say.
   */
  const check = async (
    command: string,
    unit: Unit,
    dir: string,
    log: (line: string) => void,
    { from, published, fresh }: CheckOptions = {},
  ): Promise<Check> => {
    if (unit.untrusted) return refusal("not run on an untrusted author's PR")
    await restoreGit(dir)
    const before = await uncommitted(dir)
    const alreadyDirty = baselines.get(dir) ?? new Set()
    const left = before.filter((line) => !alreadyDirty.has(line))
    if (left.length && published)
      return { output: left.join('\n'), failed: 'uncommitted changes in the clone' }
    const key = `${dir} ${await head(dir)} ${from} ${command}`
    const known = left.length || fresh ? undefined : checks.get(key)
    if (known) return known
    const env = checkEnv(input.env, dir, input.secrets, from)
    const result = await runCommand(command, dir, env, {
      secrets: [],
      signal: input.signal,
      until: input.until,
    })
    log(`check ${command}: ${result.failed ?? 'passed'}${result.output && `\n${result.output}`}`)
    await restoreGit(dir)
    // Only what the check itself left joins the baseline, never what a worker left before it.
    for (const line of await uncommitted(dir)) if (!before.includes(line)) alreadyDirty.add(line)
    baselines.set(dir, alreadyDirty)
    if (!result.stopped && !left.length && !fresh) checks.set(key, result)
    return result
  }

  /** What `condition` needs to know about the clone, its `changed` since the commit `since`; a command's output goes to `logFile`. */
  const factsFor = async (
    condition: Condition,
    unit: Unit,
    dir: string,
    since: string,
    verdict: string | undefined,
    log: (line: string) => void,
    logFile: string,
    options: CheckOptions = {},
  ) => {
    const facts: Facts = { verdict }
    let ran: RanCheck | undefined
    if (condition.command) {
      const result = await check(condition.command, unit, dir, log, options)
      ran = { command: condition.command, ...result }
      facts.command = !ran.failed
      await refuseSymlinks(dir, [relative(dir, logFile)])
      await mkdir(dirname(logFile), { recursive: true })
      await writeOutput(logFile, checkLog(ran))
    }
    if (condition.changed)
      facts.changed = (await changedPaths(dir, since, condition.changed)).length > 0
    return { facts, check: ran }
  }

  return { check, factsFor, restoreGit, rememberGitConfig, baseline }
}

export const git = async (dir: string, ...args: string[]) =>
  (await execa(bin('git'), [...inClone(dir), ...args])).stdout

export const head = (dir: string) => git(dir, 'rev-parse', 'HEAD')

export async function commitsSince(dir: string, start: string): Promise<number> {
  return Number(await git(dir, 'rev-list', '--count', `${start}..HEAD`))
}

const refusal = (failed: string): Check => ({ output: '', failed, refused: true })

/** `git status --porcelain` lines, one per uncommitted path; a nested repo's own config runs nothing. */
async function uncommitted(dir: string): Promise<string[]> {
  const status = ['status', '--porcelain', '--ignore-submodules=dirty']
  return (await git(dir, ...status)).split('\n').filter(Boolean)
}

/** The paths matching `globs` the commits since `from` change; a rename counts as both of its paths. */
export async function changedPaths(dir: string, from: string, globs: string[]) {
  const paths = globs.map((glob) => `:(glob)${glob}`)
  const diff = await git(
    dir,
    'diff',
    '--name-only',
    '--no-renames',
    `${from}...HEAD`,
    '--',
    ...paths,
  )
  return diff.split('\n').filter(Boolean)
}

/** The command and the tail of its output. */
export function checkLog({ command, output, failed }: RanCheck): string {
  const tail = output.slice(-CHECK_LOG_CHARS)
  return `$ ${command}\n${tail}\n${failed ? `failed: ${failed}` : 'passed'}\n`
}

/** `until` waits for a verdict written inside the loop, even one it only wants `{ not }` of. */
export function untilHolds(until: Condition, facts: Facts): boolean {
  return (until.verdict === undefined || facts.verdict !== undefined) && holds(until, facts)
}

/** A collapsible block with the command and the tail of its output. */
export function checkDetails(summary: string, check: RanCheck): string {
  const log = checkLog(check).trim()
  const fence = '`'.repeat(Math.max(3, ...[...log.matchAll(/`+/g)].map((m) => m[0].length + 1)))
  return [`<details><summary>${summary}</summary>`, '', fence, log, fence, '', '</details>'].join(
    '\n',
  )
}
