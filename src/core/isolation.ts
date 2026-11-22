import type { Options, ResultPromise } from 'execa'
import type { Config } from '#config/schema'
import type { Phase } from './egress'
import { unrestored } from './isolation/clones'
import { type Box, containerMode, DOCKER_TIMEOUT_MS, dockerVersion } from './isolation/container'
import { none } from './isolation/none'
import { userMode, workerFor } from './isolation/user'
import type { Login } from './types'

/** A provider's own `HOME` for its binary, written afresh before each run, whatever the isolation; see `LaunchOptions`. */
export const AGENT_HOME = '.away/agent-home'

/**
 * With `home`, the process runs with that `HOME` whatever the isolation; unset, the isolation's.
 * With `tmpdir`, a worker user's process gets that `TMPDIR`: sudo's glibc drops it from its env, so it goes on argv.
 */
export type LaunchOptions = Options & { home?: string; tmpdir?: string }

/** Where a unit's Bash runs: in the image's container, as the worker user, or as the developer. */
export interface Where {
  image?: string
  user?: string
}

/** Says why the wall doesn't hold for the worker user, if it doesn't. */
export type Holds = (user: string) => Promise<string | undefined>

/** What one isolation does with each launch, phase and wall; the module of that isolation builds it. */
export interface Mode {
  name: 'none' | 'user' | 'container'
  start<O extends LaunchOptions>(
    file: string,
    args: readonly string[],
    options: O,
  ): ResultPromise<{} & O>
  /** Runs a phase that launches repo code in the clone `dir`. */
  phase<T>(dir: string, run: () => Promise<T>, login?: Login, phase?: Phase): Promise<T>
  /** Runs a whole unit, under the worker lock when launches run as the worker user. */
  hold<T>(
    run: () => Promise<T>,
    log: (line: string) => void,
    options: { signal?: AbortSignal },
  ): Promise<T | undefined>
  /** Where the running phase's launches run in the clone `dir`. */
  where(dir: string): Where
  raiseWall(env: NodeJS.ProcessEnv, holds?: Holds): Promise<void>
  /** Where the kernel wall holds: the egress proxy is up, and every launch goes through it. */
  walled(): boolean
  /** The worker's `HOME` in the clone `dir`. */
  home?(dir: string): string | undefined
  /** Runs every launch in the clone `dir` in a container of `box`. */
  contain?(dir: string, box: Box): void
}

let mode: Mode = none

/** Runs every later launch as `next` says: as the developer's user, as the worker user, or in a container. */
export function useMode(next: Mode): void {
  mode = next
}

export const start: Mode['start'] = (file, args, options) => mode.start(file, args, options)

export const isolated = () => mode.name === 'user'
export const contained = () => mode.name === 'container'
export const whereRuns = (dir: string): Where => mode.where(dir)
export const workerHome = (dir: string) => mode.home?.(dir)
export const wallUp = () => mode.walled()

/** Runs every launch in the clone `dir` in a container of `box`. */
export const contain = (dir: string, box: Box): void => mode.contain?.(dir, box)

/** Runs a phase that launches repo code in the clone `dir`; see the mode's `phase`. */
export async function asWorker<T>(
  dir: string,
  run: () => Promise<T>,
  login?: Login,
  phase?: Phase,
): Promise<T> {
  unrestored.add(dir)
  return mode.phase(dir, run, login, phase)
}

/** Runs a whole unit under the worker lock when launches run as the worker user, waiting while another unit of the worker user holds it. Returns undefined, without running, when `signal` aborts the wait. */
export const holdingWorker = <T>(
  run: () => Promise<T>,
  log: (line: string) => void,
  options: { signal?: AbortSignal } = {},
): Promise<T | undefined> => mode.hold(run, log, options)

/** Under a worker user, probes the wall, again at each call, and starts the proxy. Awaywork's image has no wall yet and runs open; elsewhere a worker without one is refused. */
export const raiseWall = (env: NodeJS.ProcessEnv, holds?: Holds) => mode.raiseWall(env, holds)

/** Sets how every later launch runs: as the worker user, in a container once docker answers, or as the developer. */
export async function isolateFor(
  isolation: Config['isolation'],
  env: NodeJS.ProcessEnv,
): Promise<void> {
  // A failed pick still leaves the container behind, as it always did.
  if (contained()) useMode(none)
  const user = await workerFor(isolation, env)
  useMode(user ? userMode(user) : none)
  if (user || isolation !== 'container') return
  await dockerVersion().catch((e: Error) => {
    throw new Error(`isolation: container, but ${e.message}`)
  })
  useMode(containerMode(DOCKER_TIMEOUT_MS))
}

/** `isolateFor`, then the wall for the worker user it set, if any: the proxy starts where the wall holds, and a worker without one is refused. */
export async function isolateWalled(
  isolation: Config['isolation'],
  env: NodeJS.ProcessEnv,
  holds?: Holds,
): Promise<void> {
  await isolateFor(isolation, env)
  await raiseWall(env, holds)
}
