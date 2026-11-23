import { lookup } from 'node:dns/promises'
import { execa } from 'execa'
import { bin } from '#config/paths'
import { type Egress, sharedEgress } from './egress'
import { inAwayworkImage, sudoArgs, WORKER } from './sudo'

/** One command per rule, `-C` first so a second run adds nothing. Each goes in first, so the last is the first checked. */
const rules = (tool: string, user: string) =>
  [
    '-j REJECT',
    '-o lo -j ACCEPT',
    '-o lo -p udp --dport 53 -j REJECT',
    '-o lo -p tcp --dport 53 -j REJECT',
  ].map((rule) => {
    const match = `OUTPUT -m owner --uid-owner ${user} ${rule}`
    return `sudo ${tool} -C ${match} 2> /dev/null || sudo ${tool} -I ${match}`
  })

/** iptables can't see unix sockets, and systemd-resolved answers any user on its varlink socket and over D-Bus: both deny the worker, the first again after a reboot. */
const resolverLines = (user: string) => [
  '[ ! -d /run/systemd/resolve ] || command -v setfacl > /dev/null || sudo apt-get install -y acl',
  `[ ! -d /run/systemd/resolve ] || sudo setfacl -m u:${user}:--- /run/systemd/resolve`,
  `[ ! -d /run/systemd/resolve ] || printf 'd /run/systemd/resolve 0755 systemd-resolve systemd-resolve -\\na+ /run/systemd/resolve - - - - u:${user}:---\\n' | sudo tee /etc/tmpfiles.d/awaywork-${user}.conf > /dev/null`,
  `[ ! -d /etc/dbus-1/system.d ] || echo '<busconfig><policy user="${user}"><deny send_destination="org.freedesktop.resolve1"/></policy></busconfig>' | sudo tee /etc/dbus-1/system.d/awaywork-${user}.conf > /dev/null`,
  'sudo systemctl reload dbus 2> /dev/null || true',
]

/** What root runs once for the worker user: leave it only loopback, bar DNS on it and the resolver's sockets, which would answer for it. IPv4 and IPv6. */
export const wallLines = (user = WORKER): string[] => [
  ...rules('iptables', user),
  ...rules('ip6tables', user),
  ...resolverLines(user),
]

const CONTROL = 'api.github.com'
const CONTROL_V6 = '2606:4700:4700::1111'
const PROBE = [
  `timeout 3 bash -c 'exec 3<>/dev/tcp/$0/443' "$1" 2> /dev/null; echo "connect $?"`,
  'timeout 5 getent -s dns hosts "$2" > /dev/null; echo "resolve $?"',
  '[ -d /run/systemd/resolve ] && [ -x /run/systemd/resolve ]; echo "socket $?"',
  'timeout 5 busctl call org.freedesktop.resolve1 /org/freedesktop/resolve1 org.freedesktop.resolve1.Manager ResolveHostname isit 0 "$2" 0 0 > /dev/null 2>&1; echo "dbus $?"',
  '[ -w /var/run/nscd/socket ] || [ -w /run/nscd/socket ]; echo "nscd $?"',
].join('; ')
const probeOptions = { env: {}, extendEnv: false, reject: false } as const

async function probe(run: typeof execa, ip: string, as?: string) {
  const args = ['-c', PROBE, 'sh', ip, CONTROL]
  const ran = as
    ? await run(bin('sudo'), sudoArgs(as, 'bash', args, probeOptions), probeOptions)
    : await run(bin('bash'), args, probeOptions)
  if (ran.failed) return undefined
  const lines = String(ran.stdout).split('\n')
  return Object.fromEntries(lines.map((line) => line.split(' '))) as Record<string, string>
}

const addressOf = async (name: string) => (await lookup(name, { family: 4 })).address

/** Why the worker's connect to `ip` isn't the quick refusal the wall gives. */
async function connectProblem(run: typeof execa, user: string, ip: string, label: string) {
  const worker = await probe(run, ip, user)
  if (!worker) return `the probe as ${user} failed`
  if (worker.connect === '0') return `${user} reaches ${label}`
  if (worker.connect !== '1') return `${user}'s connection to ${label} isn't refused, it times out`
  return worker
}

/**
 * What keeps the wall from holding, if anything. Awaywork's own uid first connects to an outside address and resolves a
 * public name, which proves the probe can tell; the worker must then be refused at once (not time out) and resolve nothing,
 * by any road: getent, resolved's socket, D-Bus, nscd. The same for IPv6 where awaywork's own uid has a route out; with none, there's no way out over it.
 */
export async function wallProblem(
  user: string,
  run: typeof execa = execa,
  resolve = addressOf,
): Promise<string | undefined> {
  const ip = await resolve(CONTROL).catch(() => undefined)
  const control = ip && (await probe(run, ip))
  if (!ip || !control || control.connect !== '0' || control.resolve !== '0')
    return `can't tell: awaywork itself doesn't reach ${CONTROL} to compare with`
  const worker = await connectProblem(run, user, ip, CONTROL)
  if (typeof worker === 'string') return worker
  if (worker.resolve === '0') return `${user} resolves names`
  if (worker.socket === '0') return `${user} can open systemd-resolved's socket`
  if (worker.dbus === '0') return `${user} resolves names through systemd-resolved's D-Bus`
  if (worker.nscd === '0') return `nscd resolves names for ${user}: stop nscd or deny its socket`
  const v6 = await probe(run, CONTROL_V6)
  if (v6?.connect !== '0') return
  const over = await connectProblem(run, user, CONTROL_V6, `${CONTROL_V6} over IPv6`)
  if (typeof over === 'string') return over
}

/** What awaywork's image needs for the rules its entrypoint sets. */
export const NET_ADMIN_FIX =
  'the container needs NET_ADMIN for the wall: `cap_add: [NET_ADMIN]` in compose.yml'

/** Under a worker user, probes the wall, again at each call, and starts the proxy. A worker without one is refused. Returns the proxy where the wall holds. */
export async function raiseUserWall(
  worker: string,
  env: NodeJS.ProcessEnv,
  holds = wallProblem,
): Promise<Egress | undefined> {
  const problem = await holds(worker)
  const egress = problem ? undefined : await sharedEgress()
  if (problem)
    throw new Error(
      `the network wall isn't up for the ${worker} user (${problem}), so its setup, checks and MCP servers could reach any host: ${inAwayworkImage(env) ? NET_ADMIN_FIX : '`awaywork doctor` shows the rules to add'}`,
    )
  return egress
}
