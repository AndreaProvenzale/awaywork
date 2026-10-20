import { chmod, mkdtemp } from 'node:fs/promises'
import { execa, type Options } from 'execa'
import { bin } from '../config/paths.js'

/** The user `action.yml` creates on a GitHub-hosted runner for repo code to run as. */
export const WORKER = 'awaywork'
/** Never taken from the developer's env: sudo sets the first ones for the worker, the rest name the developer's own folders. */
const notPassed = [
  ...['HOME', 'USER', 'LOGNAME', 'SHELL', 'MAIL'],
  ...['XDG_CONFIG_HOME', 'XDG_CACHE_HOME', 'XDG_DATA_HOME', 'XDG_STATE_HOME', 'XDG_RUNTIME_DIR'],
]

let worker: string | undefined
let killing: Promise<unknown> = Promise.resolve()

/**
 * Starts a process that runs repo code: setup, the agent and the checks, never awaywork's own commands.
 * Isolation `none` starts it as is, as the developer's user; `user` starts it as the worker user,
 * and kills every process that user has once it exits, since the developer's user can't signal them.
 */
export function launch<O extends Options>(file: string, args: readonly string[], options: O) {
  if (!worker) return execa(file, args, options)
  const subprocess = execa(bin('sudo'), sudoArgs(worker, file, args, options), {
    ...options,
    shell: false,
  } as O)
  subprocess.nodeChildProcess.once('exit', () => void killWorker())
  return subprocess
}

export type Launch = typeof launch

/** sudo's argv running `file` as `user`: the env's names go on it, its values stay in sudo's env, which no other user can read. */
export function sudoArgs(user: string, file: string, args: readonly string[], options: Options) {
  const env = options.extendEnv === false ? options.env : { ...process.env, ...options.env }
  const names = Object.keys(env ?? {}).filter(
    (name) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(name) && !notPassed.includes(name),
  )
  // sudo looks a bare name up on its own secure_path, not the env's PATH.
  const command = options.shell
    ? ['/bin/sh', '-c', [file, ...args].join(' ')]
    : [bin(file), ...args]
  return ['-n', '-u', user, `--preserve-env=${names.join(',')}`, '--', ...command]
}

/** Runs every later launch as `user`, or as the developer's user when it's undefined. */
export function isolate(user: string | undefined): void {
  worker = user
}

export const isolated = () => worker !== undefined

/**
 * The worker user every launch runs as on a GitHub-hosted runner, none elsewhere. A hosted runner
 * without it, or where it can sudo, is refused rather than run as the runner's user.
 */
export async function hostedWorker(env: NodeJS.ProcessEnv): Promise<string | undefined> {
  if (env.RUNNER_ENVIRONMENT !== 'github-hosted') return undefined
  const as = (...command: string[]) =>
    execa(bin('sudo'), ['-n', '-u', WORKER, ...command], { reject: false })
  if ((await as('true')).failed)
    throw new Error(
      `can't run as the ${WORKER} user on this GitHub-hosted runner: run awaywork through its action, which creates it`,
    )
  if (!(await as('sudo', '-n', 'true')).failed)
    throw new Error(`the ${WORKER} user can sudo on this runner, so it isolates nothing`)
  return WORKER
}

/**
 * Runs a phase that launches repo code in the clone `dir`. Under `user`, the worker owns the clone
 * while it runs, and once it ends none of the worker's processes is left and the clone is the developer's again.
 */
export async function asWorker<T>(dir: string, run: () => Promise<T>): Promise<T> {
  const user = worker
  if (!user) return run()
  await chown(dir, `${user}:`)
  try {
    return await run()
  } finally {
    await killWorker()
    await chown(dir, `${process.getuid?.()}:${process.getgid?.()}`)
  }
}

/** A new folder the worker user can pass through but not list, for clones and skills plugins outside the developer's home. */
export async function workerRoot(): Promise<string> {
  const root = await mkdtemp('/tmp/awaywork-')
  await chmod(root, 0o711)
  return root
}

/** Kills every process of the worker user at once, so none forks or detaches its way out; one kill at a time. */
function killWorker(): Promise<unknown> {
  const user = worker
  if (!user) return killing
  killing = killing.then(() =>
    execa(bin('sudo'), ['-n', '-u', user, 'kill', '-9', '-1'], { reject: false }),
  )
  return killing
}

/** Never follows a symlink a worker planted, at the top or below. */
const chown = (dir: string, owner: string) =>
  execa(bin('sudo'), ['-n', 'chown', '-R', '-h', '-P', owner, dir])
