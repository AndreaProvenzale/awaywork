import { chmod, lstat, mkdtemp, readFile, rm } from 'node:fs/promises'
import { userInfo } from 'node:os'
import { execa, type Options } from 'execa'
import { bin } from '../config/paths.js'
import type { Config } from '../config/schema.js'
import type { Login } from './types.js'

/** The user repo code runs as under `isolation: user`, made by `action.yml` on a GitHub-hosted runner, by you elsewhere. */
export const WORKER = 'awaywork'
/** Each clone is a folder straight under the sticky `/tmp`, so no folder of the developer's sits on its path for a link to be planted in. */
const ROOT = '/tmp/awaywork-'
const CHOWN = ['/usr/bin/chown', '-R', '-h', '-P']
/** Set by sudo for the worker, so never taken from the developer's env. */
const sudoSets = ['HOME', 'USER', 'LOGNAME', 'SHELL', 'MAIL']
/** The developer's own folders, which the worker can't enter; PAM sets them from `/etc/environment` on a hosted runner. */
const developerFolders = [
  'CODEX_HOME',
  'CLAUDE_CONFIG_DIR',
  'XDG_CONFIG_HOME',
  'XDG_CACHE_HOME',
  'XDG_DATA_HOME',
  'XDG_STATE_HOME',
  'XDG_RUNTIME_DIR',
]

let worker: string | undefined
/** The worker's `HOME` in the phase that runs now. */
let phaseHome: string | undefined
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
    (name) =>
      /^[A-Za-z_][A-Za-z0-9_]*$/.test(name) &&
      !sudoSets.includes(name) &&
      !developerFolders.includes(name),
  )
  const unset = [
    '/usr/bin/env',
    ...developerFolders.flatMap((name) => ['-u', name]),
    ...(phaseHome ? [`HOME=${phaseHome}`] : []),
  ]
  // sudo looks a bare name up on its own secure_path, not the env's PATH.
  const command = options.shell
    ? ['/bin/sh', '-c', [file, ...args].join(' ')]
    : [bin(file), ...args]
  return ['-n', '-u', user, `--preserve-env=${names.join(',')}`, '--', ...unset, ...command]
}

/** Runs every later launch as `user`, or as the developer's user when it's undefined. */
export function isolate(user: string | undefined): void {
  worker = user
}

export const isolated = () => worker !== undefined

/**
 * The worker user every launch runs as: always on a GitHub-hosted runner, elsewhere under `isolation: user`.
 * One that can't run as it, or where it can sudo, is refused rather than run as the developer's user.
 */
export async function workerFor(
  isolation: Config['isolation'],
  env: NodeJS.ProcessEnv,
): Promise<string | undefined> {
  const hosted = env.RUNNER_ENVIRONMENT === 'github-hosted'
  if (isolation === 'none' && !hosted) return undefined
  if (process.platform !== 'linux')
    throw new Error(`isolation: user runs on Linux only, not ${process.platform}`)
  const as = (...command: string[]) =>
    execa(bin('sudo'), ['-n', '-u', WORKER, ...command], { reject: false })
  const ran = await as('true')
  if (ran.failed)
    throw new Error(
      hosted
        ? `can't run as the ${WORKER} user on this GitHub-hosted runner: run awaywork through its action, which creates it`
        : `can't run as the ${WORKER} user (${ran.stderr.split('\n')[0] || ran.shortMessage})`,
    )
  if (!(await as('sudo', '-n', 'true')).failed)
    throw new Error(
      `the ${WORKER} user can sudo on this ${hosted ? 'runner' : 'machine'}, so it isolates nothing`,
    )
  for (const key of ['protected_hardlinks', 'protected_symlinks'])
    if ((await readFile(`/proc/sys/fs/${key}`, 'utf8')).trim() !== '1')
      throw new Error(`fs.${key} is off, so a link the worker makes could hand it a file of yours`)
  const root = await workerRoot()
  const there = await chown(`${WORKER}:`, root)
  const back = there.failed ? there : await chown(developer(), root)
  // Left the worker's by a failed chown back, it's only the worker's to remove.
  await rm(root, { recursive: true }).catch(() => as('rmdir', root))
  if (back.failed)
    throw new Error(
      `can't chown a clone to the ${WORKER} user and back (${back.stderr || back.shortMessage})`,
    )
  return WORKER
}

/** The sudoers lines `isolation: user` needs from `user`: anything as the worker, and the two chowns it does, on a clone's folder only. */
export function sudoersLines(user = userInfo().username): string[] {
  const clone = `${ROOT}${'[A-Za-z0-9]'.repeat(6)}`
  const line = (owner: string) => [...CHOWN, owner.replace(':', '\\:'), clone].join(' ')
  return [
    `${user} ALL=(${WORKER}) NOPASSWD:SETENV: ALL`,
    `${user} ALL=(root) NOPASSWD: ${line(`${WORKER}:`)}, ${line(developer())}`,
  ]
}

/**
 * Runs a phase that launches repo code in the clone `dir`. Under `user`, the worker owns the clone and
 * a `HOME` of its own while it runs, and once it ends none of the worker's processes is left and both
 * are the developer's again: the very folders handed over, closed to everyone else.
 */
export async function asWorker<T>(dir: string, run: () => Promise<T>, login?: Login): Promise<T> {
  unrestored.add(dir)
  const user = worker
  if (!user) return run()
  if (lostToWorker(dir)) throw new Error('the clone is lost to the worker user')
  const home = homes.get(dir) ?? (await mkdtemp(ROOT))
  homes.set(dir, home)
  const save = await login?.(home)
  let back = false
  try {
    const handed = await handOver([dir, home], `${user}:`)
    phaseHome = home
    try {
      return await run()
    } finally {
      phaseHome = undefined
      await killWorker()
      await takeBack(handed)
      back = true
    }
  } finally {
    await save?.(back)
  }
}

/** Each clone's `HOME` for the worker, made at its first phase, so nothing a unit leaves in `~` reaches another clone. */
const homes = new Map<string, string>()
export const workerHome = (dir: string) => homes.get(dir)

/** Clones repo code ran in since awaywork last put their git config back: their `.git` may be the worker's. */
const unrestored = new Set<string>()
/** Whether repo code ran in the clone `dir` after its git config was last put back. */
export const gitUnrestored = (dir: string) => unrestored.has(dir)
export const markGitRestored = (dir: string) => void unrestored.delete(dir)

/** Clones and their homes a chown failed on or the worker swapped: they may still be the worker's, so awaywork touches them no more. */
const lost = new Set<string>()
/** Whether `path` is, or holds, a clone lost to the worker user. */
export const lostToWorker = (path: string) =>
  [...lost].some((dir) => dir === path || dir.startsWith(`${path}/`))

/** A new folder the worker user can pass through but not list, outside the developer's home: a clone (`0o700` until handed over), or the skills plugins. */
export async function workerRoot(mode = 0o711): Promise<string> {
  const root = await mkdtemp(ROOT)
  await chmod(root, mode)
  return root
}

const developer = () => `${process.getuid?.()}:${process.getgid?.()}`

/** Kills every process of the worker user at once, so none forks or detaches its way out; one kill at a time. */
function killWorker(): Promise<unknown> {
  const user = worker
  if (!user) return killing
  killing = killing.then(() =>
    execa(bin('sudo'), ['-n', '-u', user, 'kill', '-9', '-1'], { reject: false }),
  )
  return killing
}

/**
 * Never follows a symlink a worker planted, at the top or below; a hardlink it made is to a file it can
 * write anyway, with the `fs.protected_hardlinks` workerFor checks. A clone or home it fails on loses both.
 */
async function handOver(dirs: string[], owner: string): Promise<Handed[]> {
  const handed = await Promise.all(
    dirs.map(async (dir) => {
      const { dev, ino } = await lstat(dir)
      return { dir, dev, ino }
    }),
  )
  for (const dir of dirs) {
    // A fresh clone opens to the worker only here.
    await closeOrLose(dirs, dir)
    await chownOrLose(dirs, owner, dir)
  }
  return handed
}

interface Handed {
  dir: string
  dev: number
  ino: number
}

/**
 * Takes the folders back from the worker. In the sticky `/tmp` it can rename its own folder and leave a link
 * or a folder of its own in its place, so each must be the very folder handed over, then is the developer's alone.
 */
async function takeBack(handed: Handed[]): Promise<void> {
  const dirs = handed.map((h) => h.dir)
  for (const { dir, dev, ino } of handed) {
    await chownOrLose(dirs, developer(), dir)
    const now = await lstat(dir).catch(() => undefined)
    if (!now?.isDirectory() || now.dev !== dev || now.ino !== ino)
      lose(dirs, `${dir} isn't the folder handed to the worker, left as it is`)
    // Only after the lstat: chmod -R follows a link it's named.
    await closeOrLose(dirs, dir)
  }
}

async function closeOrLose(dirs: string[], dir: string): Promise<void> {
  const closed = await execa(bin('chmod'), ['-R', 'u+rwX,go-rwx', dir], { reject: false })
  if (closed.failed)
    lose(
      dirs,
      `couldn't close the clone to others, left as it is: ${closed.stderr || closed.shortMessage}`,
    )
  // The next phase's worker starts in it, through a chdir of the developer's.
  await chmod(dir, 0o711)
}

async function chownOrLose(dirs: string[], owner: string, dir: string): Promise<void> {
  const result = await chown(owner, dir)
  if (result.failed)
    lose(dirs, `couldn't chown the clone, left as it is: ${result.stderr || result.shortMessage}`)
}

function lose(dirs: string[], reason: string): never {
  for (const dir of dirs) lost.add(dir)
  throw new Error(reason)
}

/** The only command awaywork runs as root, shaped as the sudoers line names it. */
const chown = (owner: string, dir: string) =>
  execa(bin('sudo'), ['-n', ...CHOWN, owner, dir], { reject: false })
