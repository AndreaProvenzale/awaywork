import { execa } from 'execa'
import { bin } from '#config/paths'
import type { Config } from '#config/schema'
import { type Egress, startEgress } from './egress'
import {
  contained,
  inAwayworkImage,
  isolateFor,
  sudoArgs,
  useEgress,
  WORKER,
  workerUser,
} from './isolation'
import type { Job, Provider } from './types'

let egress: Egress | undefined

/** The rules that leave the worker user only loopback, bar DNS on it, which a resolver there would answer for it: root runs them once per boot, for IPv4 and IPv6. Each goes in first, so the last is the first checked. */
export function wallLines(user = WORKER): string[] {
  const rules = [
    '-j REJECT',
    '-o lo -j ACCEPT',
    '-o lo -p udp --dport 53 -j REJECT',
    '-o lo -p tcp --dport 53 -j REJECT',
  ]
  return ['iptables', 'ip6tables'].flatMap((tool) =>
    rules.map((rule) => `sudo ${tool} -I OUTPUT -m owner --uid-owner ${user} ${rule}`),
  )
}

/** What the worker tries to reach: an outside address, and the loopback resolver. */
const WALL_TARGETS = ['1.1.1.1:443', '127.0.0.53:53']
const WALL_PROBE = `for t; do timeout 3 bash -c 'exec 3<>/dev/tcp/\${0%:*}/\${0##*:}' "$t" 2>/dev/null && echo "$t"; done; true`
const walls = new Map<string, Promise<boolean>>()

/** Whether the worker user can reach neither of `WALL_TARGETS`, once per process for each user. */
export const wallHolds = (user: string, run: typeof execa = execa): Promise<boolean> => {
  const known = walls.get(user)
  if (known) return known
  const options = { env: {}, extendEnv: false, reject: false } as const
  const args = ['-c', WALL_PROBE, 'sh', ...WALL_TARGETS]
  const probed = run(bin('sudo'), sudoArgs(user, 'bash', args, options), options).then(
    (ran) => !ran.failed && String(ran.stdout).trim() === '',
  )
  walls.set(user, probed)
  return probed
}

/** Where the kernel wall holds for the worker user: the egress proxy is up, and every launch goes through it. */
let walled = false
export const wallUp = () => walled

/** Under a worker user, checks the wall and starts the proxy. Awaywork's image has no wall yet and runs open; elsewhere a worker without one is refused. */
async function raiseWall(env: NodeJS.ProcessEnv): Promise<void> {
  const worker = workerUser()
  walled = worker !== undefined && (await wallHolds(worker))
  if (walled) {
    egress ??= await startEgress()
    useEgress(egress)
  } else if (worker && !inAwayworkImage(env))
    throw new Error(
      `the network wall isn't up for the ${worker} user, so its setup, checks and MCP servers could reach any host: \`awaywork doctor\` shows the rules to add`,
    )
}

/** `isolateFor`, then the wall for the worker user it set, if any: the proxy starts where the wall holds, and a worker without one is refused. */
export async function isolateWalled(
  isolation: Config['isolation'],
  env: NodeJS.ProcessEnv,
): Promise<void> {
  await isolateFor(isolation, env)
  await raiseWall(env)
}

/** What each agent's shell sandbox needs, as `doctor` says it. */
export const sandboxNeeds = (agent: string) =>
  agent === 'claude'
    ? 'bubblewrap, socat and user namespaces'
    : agent === 'codex'
      ? 'bubblewrap and user namespaces'
      : 'user namespaces'

/**
 * Why a unit can't run: its agent's shell sandbox can't start here and awaywork's wall doesn't hold, so its shell would
 * reach any host. awaywork's image and `container` keep running open until their walls land; a provider with no sandbox is exempt.
 */
export async function shellRefusal(
  provider: Provider,
  job: Pick<Job, 'dir'>,
  signal?: AbortSignal,
): Promise<string | undefined> {
  if (!provider.startsSandbox || walled || contained() || inAwayworkImage(process.env)) return
  if (await provider.startsSandbox(job, signal)) return
  return `${provider.id}'s shell sandbox can't start here (needs ${sandboxNeeds(provider.id)}) and no network wall holds: install them, or run under isolation: user, whose wall \`awaywork doctor\` shows`
}
