import { chmod, lstat, mkdtemp, readFile, rm } from 'node:fs/promises'
import { userInfo } from 'node:os'
import { join } from 'node:path'
import { execa } from 'execa'
import { bin, profile, rootStateDir } from '#config/paths'
import type { Config } from '#config/schema'
import { lock } from '#util/lock'
import { type Egress, type Phase, proxyEnv } from '../egress'
import type { LaunchOptions, Mode } from '../isolation'
import type { Login } from '../types'
import { lose, lostToWorker } from './clones'
import {
  CHOWN,
  chown,
  developer,
  hostedRunner,
  inAwayworkImage,
  ROOT,
  sudoArgs,
  WORKER,
  workerNamed,
} from './sudo'
import { raiseUserWall } from './user-wall'

/** Linux's longest user name. */
export const MAX_USER = 32

/** Held across every process of one worker user, whichever profile: `killWorker` ends every process of that user, whoever's unit it belongs to. */
export const WORKER_LOCK = join(rootStateDir, 'workers', `${WORKER}.lock`)

/** Runs every launch as `user`, in a phase with a `HOME` of its own, where the kernel wall holds through awaywork's proxy. */
export function userMode(user: string): Mode {
  /** The proxy every launch of the worker user goes through, where the kernel wall holds. */
  let egress: Egress | undefined
  /** The worker's `HOME` in the phase that runs now. */
  let phaseHome: string | undefined
  let killing: Promise<unknown> = Promise.resolve()
  /** Each clone's `HOME` for the worker, made at its first phase, so nothing a unit leaves in `~` reaches another clone. */
  const homes = new Map<string, string>()

  /** Kills every process of the worker user at once, so none forks or detaches its way out; one kill at a time. */
  function killWorker(): Promise<unknown> {
    killing = killing.then(() =>
      // Without `--`, procps 4.0.4-8+ (Ubuntu 26.04) takes `-1` for an option and kills nothing.
      execa(bin('sudo'), ['-n', '-u', user, 'kill', '-9', '--', '-1'], { reject: false }),
    )
    return killing
  }

  return {
    name: 'user',
    start<O extends LaunchOptions>(file: string, args: readonly string[], options: O) {
      const { home: _, tmpdir: __, ...rest } = options
      const walled = egress ? { ...rest, env: { ...rest.env, ...proxyEnv(egress.port) } } : rest
      const subprocess = execa(
        bin('sudo'),
        sudoArgs(user, file, args, {
          ...options,
          ...walled,
          home: options.home ?? phaseHome,
        }),
        { ...walled, shell: false } as O,
      )
      subprocess.nodeChildProcess.once('exit', () => void killWorker())
      return subprocess
    },
    /**
     * Runs a phase that launches repo code in the clone `dir`. Under `user`, the worker owns the clone and
     * a `HOME` of its own while it runs, and once it ends none of the worker's processes is left and both
     * are the developer's again: the very folders handed over, closed to everyone else.
     * Where the network wall holds, its launches reach only the hosts of its `phase`, through awaywork's proxy.
     */
    async phase<T>(dir: string, run: () => Promise<T>, login?: Login, phase?: Phase): Promise<T> {
      if (lostToWorker(dir)) throw new Error('the clone is lost to the worker user')
      const home = homes.get(dir) ?? (await mkdtemp(ROOT))
      homes.set(dir, home)
      const save = await login?.(home)
      let back = false
      try {
        const handed = await handOver([dir, home], `${user}:`)
        phaseHome = home
        egress?.use(phase)
        try {
          return await run()
        } finally {
          phaseHome = undefined
          egress?.use()
          await killWorker()
          await takeBack(handed)
          back = true
        }
      } finally {
        await save?.(back)
      }
    },
    /** Runs a whole unit under the worker lock, waiting while another unit of the worker user holds it. Returns undefined, without running, when `signal` aborts the wait. */
    async hold<T>(
      run: () => Promise<T>,
      log: (line: string) => void,
      { signal }: { signal?: AbortSignal } = {},
    ): Promise<T | undefined> {
      const release = await lock(WORKER_LOCK, (line) => log(`worker user: ${line}`), signal).catch(
        (e) => {
          if (signal?.aborted) return undefined
          throw e
        },
      )
      if (!release) return undefined
      try {
        return await run()
      } finally {
        await release()
      }
    },
    where: () => ({ user }),
    async raiseWall(env, holds) {
      // a refused wall throws, and must leave no proxy behind
      egress = undefined
      egress = await raiseUserWall(user, env, holds)
    },
    walled: () => egress !== undefined,
    home: (dir) => homes.get(dir),
  }
}

/**
 * The worker user every launch runs as: always on a GitHub-hosted runner and in awaywork's image, elsewhere under `isolation: user`.
 * One that can't run as it, or where it can sudo, is refused rather than run as the developer's user.
 */
export async function workerFor(
  isolation: Config['isolation'],
  env: NodeJS.ProcessEnv,
): Promise<string | undefined> {
  const hosted = hostedRunner(env)
  const image = inAwayworkImage(env)
  if (isolation !== 'user' && !hosted && !image) return undefined
  const user = workerNamed(profile.name, env)
  if (user.length > MAX_USER)
    throw new Error(
      `the worker user ${user} is over ${MAX_USER} characters, Linux's limit: pick a profile name of ${MAX_USER - 'awaywork-'.length} or fewer`,
    )
  if (process.platform !== 'linux')
    throw new Error(`isolation: user runs on Linux only, not ${process.platform}`)
  const as = (...command: string[]) =>
    execa(bin('sudo'), ['-n', '-u', user, ...command], { reject: false })
  const ran = await as('true')
  if (ran.failed)
    throw new Error(
      hosted
        ? `can't run as the ${user} user on this GitHub-hosted runner: run awaywork through its action, which creates it`
        : image
          ? `can't run as the ${user} user in this image: build it from awaywork's Dockerfile, which creates it`
          : `can't run as the ${user} user (${ran.stderr.split('\n')[0] || ran.shortMessage})`,
    )
  if (!(await as('sudo', '-n', 'true')).failed)
    throw new Error(
      `the ${user} user can sudo on this ${hosted ? 'runner' : 'machine'}, so it isolates nothing`,
    )
  for (const key of ['protected_hardlinks', 'protected_symlinks'])
    if ((await readFile(`/proc/sys/fs/${key}`, 'utf8')).trim() !== '1')
      throw new Error(`fs.${key} is off, so a link the worker makes could hand it a file of yours`)
  const root = await workerRoot()
  const there = await chown(`${user}:`, root)
  const back = there.failed ? there : await chown(developer(), root)
  // Left the worker's by a failed chown back, it's only the worker's to remove.
  await rm(root, { recursive: true }).catch(() => as('rmdir', root))
  if (back.failed)
    throw new Error(`can't chown a clone to the ${user} user and back (${failure(back)})`)
  return user
}

/** The sudoers lines `isolation: user` needs from `user` (uid:gid `owner`): anything as the worker, and the two chowns it does, on a clone's folder only. */
export function sudoersLines(user = userInfo().username, owner = developer()): string[] {
  const clone = `${ROOT}${'[A-Za-z0-9]'.repeat(6)}`
  const line = (to: string) => [...CHOWN, to.replace(':', '\\:'), clone].join(' ')
  return [
    `${user} ALL=(${WORKER}) NOPASSWD:SETENV: ALL`,
    `${user} ALL=(root) NOPASSWD: ${line(`${WORKER}:`)}, ${line(owner)}`,
  ]
}

/** A new folder the worker user can pass through but not list, outside the developer's home: a clone (`0o700` until handed over), or the skills plugins. */
export async function workerRoot(mode = 0o711): Promise<string> {
  const root = await mkdtemp(ROOT)
  await chmod(root, mode)
  return root
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
  // A fresh clone opens to the worker only from here; all closed before any chown, as a file the clone links from the home (pnpm's store) changes owner with it.
  for (const dir of dirs) await closeOrLose(dirs, dir)
  for (const dir of dirs) await chownOrLose(dirs, owner, dir)
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
    lose(dirs, `couldn't close the clone to others, left as it is: ${failure(closed)}`)
  // The next phase's worker starts in it, through a chdir of the developer's.
  await chmod(dir, 0o711)
}

async function chownOrLose(dirs: string[], owner: string, dir: string): Promise<void> {
  const result = await chown(owner, dir)
  if (result.failed) lose(dirs, `couldn't chown the clone, left as it is: ${failure(result)}`)
}

/** A failed command's stderr as one line, and how many more it had: a chmod -R can fail on every file. */
export function failure(ran: { stderr: string; shortMessage?: string }): string {
  const [first, ...more] = ran.stderr.trim().split('\n')
  if (!first) return String(ran.shortMessage)
  return more.length ? `${first} (and ${more.length} more)` : first
}
