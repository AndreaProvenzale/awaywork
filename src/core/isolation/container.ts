import { randomBytes } from 'node:crypto'
import { existsSync } from 'node:fs'
import { lstat, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { execa } from 'execa'
import { bin } from '#config/paths'
import type { Login } from '../types'
import type { LaunchOptions, Mode } from '.'
import { lose, lost, lostToWorker } from './clones'
import { type ContainerWall, raiseContainerWall } from './container-wall'
import { type Egress, type Phase, PROXY_ENV, sharedEgress } from './egress'
import { developer } from './sudo'

/** The names awaywork sets in a phase's env (`commandEnv`, `workerEnv`, the checks', the providers), which a container always gets. */
export const AWAYWORK_ENV = [
  'GH_CONFIG_DIR',
  'GH_TOKEN',
  'GH_ENTERPRISE_TOKEN',
  'TWG_CONFIG_DIR',
  'GIT_CONFIG_GLOBAL',
  'GIT_CONFIG_NOSYSTEM',
  'GIT_NO_REPLACE_OBJECTS',
  'GIT_ATTR_SOURCE',
  'AWAYWORK_OUT_DIR',
  'ENABLE_CLAUDEAI_MCP_SERVERS',
  'AWAYWORK_PROMPT',
  'AWAYWORK_FROM',
  'AGENT_CLI_CREDENTIAL_STORE',
]

/** The container's `HOME`, in the clone and gone with it: what setup installs there reaches the chain's agents and checks, never another chain. */
export const CONTAINER_HOME = '.away/home'

/** How long awaywork waits on a docker command of its own: past it, a stopped daemon counts as gone. */
export const DOCKER_TIMEOUT_MS = 60_000
let removing: Promise<unknown> = Promise.resolve()
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

/** Runs every launch in a container, after `contain` says which image a clone's runs in. */
export function containerMode(dockerTimeout = DOCKER_TIMEOUT_MS): Mode {
  /** Each clone's container under `isolation: container`. */
  const boxes = new Map<string, Box>()
  /** The containers launched in the running phase, by name. */
  const started = new Set<string>()
  /** Where the network wall holds: the proxy every launch goes through, and the network that leads only to it. */
  let wall: (ContainerWall & { egress: Egress }) | undefined

  /**
   * Under `container`, a phase gets the clone's `HOME`, and once it ends none of its containers is left.
   * Nothing in the clone is touched through a link one left, nor at all while one may still run.
   */
  async function inContainers<T>(
    dir: string,
    run: () => Promise<T>,
    login?: Login,
    phase?: Phase,
  ): Promise<T> {
    if (lostToWorker(dir)) throw new Error('the clone is lost: a container of it may still run')
    await refuseLinks(dir)
    const home = join(dir, CONTAINER_HOME)
    await mkdir(home, { recursive: true })
    const save = await login?.(home)
    try {
      wall?.egress.use(phase)
      return await run()
    } finally {
      wall?.egress.use()
      const gone = await removeContainers([...started], dockerTimeout)
      started.clear()
      // Lost before the save, so a save that throws can't leave it open.
      if (!gone) lost.add(dir)
      await save?.(gone && !(await linked(dir)))
      if (!gone) lose([dir], "couldn't remove the phase's container, left the clone as it is")
    }
  }

  return {
    name: 'container',
    start<O extends LaunchOptions>(file: string, args: readonly string[], options: O) {
      const { home: _, ...rest } = options
      const walled = wall ? { ...options, env: { ...options.env, ...wall.env } } : options
      const dir = String(options.cwd)
      const box = boxes.get(dir)
      if (!box) throw new Error(`no container for ${dir}`)
      const name = `awaywork-${randomBytes(6).toString('hex')}`
      const env = options.extendEnv === false ? walled.env : { ...process.env, ...walled.env }
      started.add(name)
      const subprocess = execa(
        bin('docker'),
        dockerArgs(name, box, file, args, walled, wall?.network),
        {
          ...rest,
          shell: false,
          env: { ...process.env, ...env },
          extendEnv: false,
        } as O,
      )
      subprocess.nodeChildProcess.once('exit', () => void removeContainers([name], dockerTimeout))
      return subprocess
    },
    phase: inContainers,
    hold: (run) => run(),
    where: (dir) => ({ image: boxes.get(dir)?.image }),
    async raiseWall() {
      // a wall that fails must leave none up
      wall = undefined
      const egress = await sharedEgress()
      wall = { ...(await raiseContainerWall(egress)), egress }
    },
    walled: () => wall !== undefined,
    /** Runs every launch in the clone `dir` in a container of `box`. */
    contain: (dir, box) => void boxes.set(dir, box),
  }
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
 * With a `network`, the container joins only it, and the proxy's names go in too.
 */
export function dockerArgs(
  name: string,
  box: Box,
  file: string,
  args: readonly string[],
  options: LaunchOptions,
  network?: string,
): string[] {
  const dir = String(options.cwd)
  const env = (options.extendEnv === false ? options.env : { ...process.env, ...options.env }) ?? {}
  const names = Object.keys(env).filter(
    (name) =>
      /^[A-Za-z_][A-Za-z0-9_]*$/.test(name) &&
      name !== 'HOME' &&
      env[name] !== undefined &&
      (box.secrets.includes(name) ||
        AWAYWORK_ENV.includes(name) ||
        (network !== undefined && PROXY_ENV.includes(name))),
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
    ...(network ? ['--network', network] : []),
    '-w',
    dir,
    ...mount(dir),
    ...plugin,
    '-e',
    `HOME=${options.home ?? join(dir, CONTAINER_HOME)}`,
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
function removeContainers(names: string[], timeout: number): Promise<boolean> {
  // A minute each is enough to know docker isn't answering about them.
  const docker = async (...args: string[]) => {
    const ran = await execa(bin('docker'), args, { reject: false, timeout })
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
