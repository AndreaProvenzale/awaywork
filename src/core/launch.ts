import type { ChildProcess } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { existsSync } from 'node:fs'
import { chmod, lstat, mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { userInfo } from 'node:os'
import { join } from 'node:path'
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

/** The names awaywork sets in a phase's env (`commandEnv`, `workerEnv`, the providers), which a container always gets. */
export const AWAYWORK_ENV = [
  'GH_CONFIG_DIR',
  'GH_TOKEN',
  'GH_ENTERPRISE_TOKEN',
  'GIT_CONFIG_GLOBAL',
  'GIT_CONFIG_NOSYSTEM',
  'ENABLE_CLAUDEAI_MCP_SERVERS',
  'AWAYWORK_PROMPT',
]

/** The container's `HOME`, in the clone and gone with it: what setup installs there reaches the chain's agents and checks, never another chain. */
export const CONTAINER_HOME = '.away/home'

let worker: string | undefined
/** The worker's `HOME` in the phase that runs now. */
let phaseHome: string | undefined
let killing: Promise<unknown> = Promise.resolve()
let boxed = false
/** Each clone's container under `isolation: container`. */
const boxes = new Map<string, Box>()
/** The containers launched in the running phase, by name. */
const started = new Set<string>()
let removing: Promise<unknown> = Promise.resolve()
/** How long awaywork waits on a docker command of its own: past it, a stopped daemon counts as gone. */
export const DOCKER_TIMEOUT_MS = 60_000
let dockerTimeout = DOCKER_TIMEOUT_MS
/** Containers a removal of timed out on. */
const unanswered = new Set<string>()

export interface Box {
  /** The repo's image, with the agent CLIs and its toolchain. */
  image: string
  /** The skills plugin, mounted read-only when there is one. */
  plugin?: string
  /** The secrets the config names: the ones still in a launch's env are the phase's, and go in by name. */
  secrets: string[]
}

/**
 * Starts a process that runs repo code: setup, the agent and the checks, never awaywork's own commands.
 * Isolation `none` starts it as is, as the developer's user; `user` starts it as the worker user,
 * and kills every process that user has once it exits, since the developer's user can't signal them;
 * `container` starts it in a fresh container, removed once its client exits, since killing that stops nothing inside.
 * Once it's both stopped by its `cancelSignal` and exited, its output closes a moment later, whatever still holds it.
 */
export function launch<O extends Options>(file: string, args: readonly string[], options: O) {
  const subprocess = start(file, args, options)
  closeOutputOnceStopped(subprocess.nodeChildProcess, options.cancelSignal)
  return subprocess
}

/** How long a stopped launch's output stays open after it exits: past it, only a process that left its group holds it. */
const STOPPED_OUTPUT_MS = 1000

/** A process that left the group, like `setsid sleep 900 &`, would hold the pipe, and the provider reading it, until it exits. */
function closeOutputOnceStopped(child: ChildProcess, signal?: AbortSignal): void {
  if (!signal) return
  const exited = new Promise((ok) => child.once('exit', ok))
  const stopped = new Promise((ok) =>
    signal.aborted ? ok(undefined) : signal.addEventListener('abort', ok, { once: true }),
  )
  void Promise.all([exited, stopped]).then(() =>
    setTimeout(() => {
      child.stdout?.destroy()
      child.stderr?.destroy()
    }, STOPPED_OUTPUT_MS),
  )
}

function start<O extends Options>(file: string, args: readonly string[], options: O) {
  if (boxed) return inContainer(file, args, options)
  if (!worker) return execa(file, args, options)
  const subprocess = execa(bin('sudo'), sudoArgs(worker, file, args, options), {
    ...options,
    shell: false,
  } as O)
  subprocess.nodeChildProcess.once('exit', () => void killWorker())
  return subprocess
}

export type Launch = typeof launch

function inContainer<O extends Options>(file: string, args: readonly string[], options: O) {
  const dir = String(options.cwd)
  const box = boxes.get(dir)
  if (!box) throw new Error(`no container for ${dir}`)
  const name = `awaywork-${randomBytes(6).toString('hex')}`
  const env = options.extendEnv === false ? options.env : { ...process.env, ...options.env }
  started.add(name)
  const subprocess = execa(bin('docker'), dockerArgs(name, box, file, args, options), {
    ...options,
    shell: false,
    env: { ...process.env, ...env },
    extendEnv: false,
  } as O)
  subprocess.nodeChildProcess.once('exit', () => void removeContainers([name]))
  return subprocess
}

/** Runs every launch in the clone `dir` in a container of `box`. */
export function contain(dir: string, box: Box): void {
  boxes.set(dir, box)
}

/** The first of the clone's `.away` and `HOME` that is a symlink, which a container may have left for awaywork to go through. */
async function linked(dir: string): Promise<string | undefined> {
  for (const path of ['.away', CONTAINER_HOME])
    if ((await lstat(join(dir, path)).catch(() => undefined))?.isSymbolicLink()) return path
}

async function refuseLinks(dir: string): Promise<void> {
  const link = await linked(dir)
  if (link) throw new Error(`${link} in the clone is a symlink`)
}

/** Runs every later launch in a container, or as before when `on` is false. */
export function containerize(on: boolean, timeout = DOCKER_TIMEOUT_MS): void {
  boxed = on
  dockerTimeout = timeout
}

export const contained = () => boxed

/**
 * Every container's flags: removed once it exits, an init that reaps, the command as given rather than to the image's
 * entrypoint, and the developer's uid and gid, so the clone's files stay theirs, with no way to more.
 */
const runFlags = () => [
  'run',
  '--rm',
  '--init',
  '--entrypoint=',
  '--user',
  developer(),
  '--cap-drop=ALL',
  '--security-opt=no-new-privileges',
]

/**
 * docker's argv running `file` in a fresh container: the clone at its own path and the plugin read-only, nothing else,
 * and the env's names, whose values the client reads from its own env. Only the names awaywork sets and the phase's secrets go in.
 */
export function dockerArgs(
  name: string,
  box: Box,
  file: string,
  args: readonly string[],
  options: Options,
): string[] {
  const dir = String(options.cwd)
  const env = (options.extendEnv === false ? options.env : { ...process.env, ...options.env }) ?? {}
  const names = Object.keys(env).filter(
    (name) =>
      /^[A-Za-z_][A-Za-z0-9_]*$/.test(name) &&
      name !== 'HOME' &&
      env[name] !== undefined &&
      (box.secrets.includes(name) || AWAYWORK_ENV.includes(name)),
  )
  const mount = (path: string, more = '') => [
    '--mount',
    `type=bind,source=${path},target=${path}${more}`,
  ]
  const plugin = box.plugin && existsSync(box.plugin) ? mount(box.plugin, ',readonly') : []
  const command = options.shell ? ['/bin/sh', '-c', [file, ...args].join(' ')] : [file, ...args]
  return [
    ...runFlags(),
    '-i',
    '--name',
    name,
    '-w',
    dir,
    ...mount(dir),
    ...plugin,
    '-e',
    `HOME=${join(dir, CONTAINER_HOME)}`,
    ...names.flatMap((name) => ['-e', name]),
    box.image,
    ...command,
  ]
}

/** docker's argv running `command` in a container of `image` with nothing but `mounts` read-only, as doctor checks it. */
export const inImage = (image: string, command: string[], mounts: string[] = []) => [
  ...runFlags(),
  ...mounts.flatMap((path) => ['--mount', `type=bind,source=${path},target=${path},readonly`]),
  '-e',
  'HOME=/tmp',
  image,
  ...command,
]

/** The Docker engine's version; throws when docker can't reach it. */
export async function dockerVersion(timeout = DOCKER_TIMEOUT_MS): Promise<string> {
  const docker = await execa(bin('docker'), ['version', '--format', '{{.Server.Version}}'], {
    reject: false,
    timeout,
  })
  if (docker.failed)
    throw new Error(
      `docker isn't reachable (${(docker.stderr.trim() || String(docker.shortMessage)).split('\n')[0]})`,
    )
  return docker.stdout.trim()
}

/**
 * Removes the containers, one removal at a time so none races another, and says whether none is left running:
 * not when docker doesn't answer.
 */
function removeContainers(names: string[]): Promise<boolean> {
  // A minute each is enough to know docker isn't answering about them.
  const docker = async (...args: string[]) => {
    const ran = await execa(bin('docker'), args, { reject: false, timeout: dockerTimeout })
    if (ran.timedOut) for (const name of names) unanswered.add(name)
    return ran
  }
  const removed = removing.then(async () => {
    if (!names.length) return true
    if (names.some((name) => unanswered.has(name))) return false
    if ((await docker('rm', '-f', ...names)).timedOut) return false
    const left = await docker(
      'ps',
      '-q',
      ...names.flatMap((name) => ['--filter', `name=^${name}$`]),
    )
    return !left.failed && left.stdout.trim() === ''
  })
  removing = removed
  return removed
}

/** Stops every container of the running phase, so what it left in the clone is final. */
export const stopContainers = () => removeContainers([...started])

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
  if (isolation !== 'user' && !hosted) return undefined
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

/** Sets how every later launch runs: as the worker user, in a container once docker answers, or as the developer. */
export async function isolateFor(
  isolation: Config['isolation'],
  env: NodeJS.ProcessEnv,
): Promise<void> {
  isolate(await workerFor(isolation, env))
  if (isolation !== 'container' || worker) return
  await dockerVersion().catch((e: Error) => {
    throw new Error(`isolation: container, but ${e.message}`)
  })
  boxed = true
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
  if (boxed) return inContainers(dir, run, login)
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

/**
 * Under `container`, a phase gets the clone's `HOME`, and once it ends none of its containers is left.
 * Nothing in the clone is touched through a link one left, nor at all while one may still run.
 */
async function inContainers<T>(dir: string, run: () => Promise<T>, login?: Login): Promise<T> {
  if (lostToWorker(dir)) throw new Error('the clone is lost: a container of it may still run')
  await refuseLinks(dir)
  const home = join(dir, CONTAINER_HOME)
  await mkdir(home, { recursive: true })
  const save = await login?.(home)
  try {
    return await run()
  } finally {
    const gone = await stopContainers()
    started.clear()
    // Lost before the save, so a save that throws can't leave it open.
    if (!gone) lost.add(dir)
    await save?.(gone && !(await linked(dir)))
    if (!gone) lose([dir], "couldn't remove the phase's container, left the clone as it is")
  }
}

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
