import { spawnSync } from 'node:child_process'
import { randomBytes, randomInt } from 'node:crypto'
import { hostname } from 'node:os'
import { execa } from 'execa'
import { bin } from '#config/paths'
import { type Egress, type Exposed, proxyEnv } from './egress'

/** The official Node image the forwarder and the probes run: pinned by digest, so no tag can swap what holds the wall. */
export const WALL_IMAGE =
  'node:26-alpine@sha256:6bd9ab43c0ec0190ca7b2d193906cb8b7edf6e7f4afa43ddeccd6452710bffb5'

const LABEL = 'awaywork.wall'
const ALIAS = 'awaywork-egress'
const FORWARDER_PORT = 3128
const OUTSIDE = '1.1.1.1:443'
const TIMEOUT_MS = 60_000

/** Pipes every connection to awaywork's proxy at argv `host port`: the one way out of the internal network. */
const FORWARDER = `const net = require('net')
const [host, port] = process.argv.slice(1)
net.createServer((from) => {
  const to = net.connect(Number(port), host)
  const end = () => { from.destroy(); to.destroy() }
  for (const s of [from, to]) { s.on('error', end); s.on('close', end) }
  from.pipe(to); to.pipe(from)
}).listen(${FORWARDER_PORT}, '0.0.0.0')`

/** Listens on the docker host's own network, to see whether a container of the wall's network reaches the host's services. */
const CANARY = `const s = require('net').createServer((c) => c.end()).listen(Number(process.argv[1]), '0.0.0.0', () => console.log('ready'))
s.on('error', () => process.exit(1))
setTimeout(() => process.exit(0), 120000)`

/** Prints what a container on the wall's network reaches; argv: the forwarder's alias, the token, then targets, those starting with host= being the docker host's. */
const PROBE = `const net = require('net'), dns = require('dns')
const [alias, token, ...targets] = process.argv.slice(1)
const tcp = (host, port) => new Promise((done) => {
  const s = net.connect({ host, port: Number(port), timeout: 3000 })
  s.on('connect', () => { s.destroy(); done('open') })
  s.on('timeout', () => { s.destroy(); done('timeout') })
  s.on('error', (e) => done(e.code || 'error'))
})
const resolver = new dns.promises.Resolver({ timeout: 1500, tries: 1 })
const lookup = (name) => resolver.resolve4(name).then((a) => a.join(','), (e) => e.code)
const via = (auth) => new Promise((done) => {
  const s = net.connect(${FORWARDER_PORT}, alias)
  let seen = ''
  s.setTimeout(5000, () => { s.destroy(); done('timeout') })
  s.on('connect', () => s.write('CONNECT awaywork.invalid:443 HTTP/1.1\\r\\nHost: x\\r\\n' + (auth ? 'Proxy-Authorization: Basic ' + Buffer.from('awaywork:' + token).toString('base64') + '\\r\\n' : '') + '\\r\\n'))
  s.on('data', (b) => { seen += b; if (seen.includes('\\r\\n')) { s.destroy(); done(seen.split('\\r\\n')[0]) } })
  s.on('error', (e) => done(e.code || 'error'))
})
;(async () => {
  const seen = await Promise.all([
    ...targets.map(async (t) => {
      const target = t.replace(/^host=/, '')
      return [t === target ? 'direct' : 'host', target, await tcp(target.slice(0, target.lastIndexOf(':')), target.slice(target.lastIndexOf(':') + 1))]
    }),
    via(false).then((answer) => ['anonymous', answer]),
    via(true).then((answer) => ['token', answer]),
  ])
  for (const name of ['registry.npmjs.org', 'host.docker.internal']) seen.push(['dns', name, await lookup(name)])
  for (const line of seen) console.log(line.join(' '))
})()`

/** Prints `outside open` at the first connect to a public address, trying two, twice (a network just up can miss one), then `canary open` if argv `host port` accepts: proof the canary is still listening. */
const CONTROL = `const net = require('net')
const tcp = (host, port) => new Promise((done) => {
  const s = net.connect({ host, port, timeout: 3000 })
  s.on('connect', () => { s.destroy(); done(true) })
  s.on('timeout', () => { s.destroy(); done(false) })
  s.on('error', () => done(false))
})
;(async () => {
  for (const host of ['1.1.1.1', '8.8.8.8', '1.1.1.1', '8.8.8.8'])
    if (await tcp(host, 443)) { console.log('outside open'); break }
  const [host, port] = process.argv.slice(1)
  if (host && await tcp(host, Number(port))) console.log('canary open')
})()`

const unwalled = (reason: string) =>
  new Error(
    `the network wall isn't up for containers (${reason}), so setup, the checks and MCP servers could reach any host: \`awaywork doctor\` repeats the check`,
  )

const docker = (args: string[], timeout = TIMEOUT_MS) =>
  execa(bin('docker'), args, { reject: false, timeout })

const firstLine = (ran: { stderr: string; shortMessage?: string }) =>
  ran.stderr.trim().split('\n').at(-1) || String(ran.shortMessage)

/** A wall that is up: the internal network launch containers join, and what points their tools at the forwarder. */
export interface ContainerWall {
  network: string
  env: Record<string, string>
}

interface Raised extends ContainerWall {
  forwarder: string
  exposed: Exposed
}

let raised: Raised | undefined
let hooked = false

const alive = (pid: number) => {
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM'
  }
}

const owner = () => `${hostname()}:${process.pid}`

/** Whether a wall's label names a process of this machine that is gone: another machine's walls are none of ours. */
const deadHere = (label: string) => {
  const at = label.lastIndexOf(':')
  return label.slice(0, at) === hostname() && !alive(Number(label.slice(at + 1)))
}

/** Removes the walls an awaywork process that is gone left, found by label. */
async function sweep(): Promise<void> {
  const owned = async (args: string[], name: string) => {
    const ran = await docker([
      ...args,
      '--filter',
      `label=${LABEL}`,
      '--format',
      `{{.${name}}} {{.Label "${LABEL}"}}`,
    ])
    return ran.stdout
      .split('\n')
      .map((line) => line.split(' '))
      .filter(([name, owner]) => name && deadHere(owner ?? ''))
      .map(([name]) => name as string)
  }
  const containers = await owned(['ps', '-a'], 'Names')
  if (containers.length) await docker(['rm', '-f', ...containers])
  for (const network of await owned(['network', 'ls'], 'Name'))
    await docker(['network', 'rm', network])
}

/** The default bridge's gateway: where a container reaches awaywork when this machine is the engine's host. */
async function bridgeGateway(): Promise<string | undefined> {
  const ran = await docker([
    'network',
    'inspect',
    'bridge',
    '--format',
    '{{range .IPAM.Config}}{{.Gateway}} {{end}}',
  ])
  return ran.stdout.split(' ').find((address) => /^\d+\.\d+\.\d+\.\d+$/.test(address))
}

/** The addresses a network's gateway would have: its own, or the first of each subnet, which is the host's where docker assigns it. */
export function gatewaysOf(configs: { Subnet?: string; Gateway?: string }[]): string[] {
  return configs.flatMap(({ Subnet = '', Gateway }) => {
    if (Gateway) return [Gateway]
    const base = Subnet.replace(/\/\d+$/, '')
    if (/^\d+\.\d+\.\d+\.0$/.test(base)) return [base.replace(/0$/, '1')]
    return base.endsWith('::') ? [`${base}1`] : []
  })
}

async function networkGateways(network: string): Promise<string[]> {
  const ran = await docker(['network', 'inspect', network, '--format', '{{json .IPAM.Config}}'])
  try {
    return gatewaysOf(JSON.parse(ran.stdout) ?? [])
  } catch {
    throw unwalled(`can't read the gateway of its network: ${firstLine(ran)}`)
  }
}

/** A listener on the docker host's network, at a port the wall's network must not reach through its gateway. */
async function startCanary(name: string, label: string[]): Promise<number> {
  const hint = "can't tell whether its network's gateway reaches the host"
  for (let attempt = 0; attempt < 3; attempt++) {
    const port = randomInt(20_000, 60_000)
    const started = await docker([
      'run',
      '-d',
      '--rm',
      '--name',
      name,
      ...label,
      '--cap-drop=ALL',
      '--security-opt=no-new-privileges',
      '--read-only',
      '--user',
      'node',
      '--network',
      'host',
      WALL_IMAGE,
      'node',
      '-e',
      CANARY,
      String(port),
    ])
    if (started.failed)
      throw unwalled(
        `${hint}: a listener on docker's host network didn't start (${firstLine(started)}); \`container\` needs \`docker run --network host\` to work, which Docker Desktop's Enhanced Container Isolation blocks`,
      )
    for (let tries = 0; tries < 25; tries++) {
      const logs = await docker(['logs', name])
      if (logs.stdout.includes('ready')) return port
      if (logs.failed) break
      await new Promise((wait) => setTimeout(wait, 200))
    }
    await docker(['rm', '-f', name])
  }
  throw unwalled(
    `${hint}: the listener on docker's host network didn't come up, its port was taken three times or something stopped it`,
  )
}

async function ensureImage(): Promise<void> {
  if (!(await docker(['image', 'inspect', WALL_IMAGE])).failed) return
  const pulled = await docker(['pull', '--quiet', WALL_IMAGE], 10 * TIMEOUT_MS)
  if (pulled.failed)
    throw unwalled(
      `${WALL_IMAGE} isn't here and couldn't be pulled: ${firstLine(pulled)}; run \`docker pull ${WALL_IMAGE}\` once online`,
    )
}

const flags = (network?: string) => [
  '--cap-drop=ALL',
  '--security-opt=no-new-privileges',
  '--read-only',
  '--user',
  'node',
  ...(network ? ['--network', network] : []),
]

/** What keeps the wall from holding, if anything, from what a throwaway container of the network and one of the default bridge saw. */
export function probeProblem(seen: string, control: string, forwarded: string): string | undefined {
  if (!control.includes('outside open'))
    return `can't tell: a container on docker's default network doesn't reach ${OUTSIDE} to compare with, and \`container\` can't be walled on a network that only reaches the internet through a proxy`
  if (!control.includes('canary open'))
    return `can't tell: a container on docker's default network doesn't reach the listener on docker's host network, so the gateway check proves nothing`
  const lines = seen.split('\n').map((line) => line.split(' '))
  const result = (kind: string) => lines.filter(([k]) => k === kind)
  for (const [, target, answer] of result('direct'))
    if (answer === 'open') return `a container on the wall's network reaches ${target} directly`
    else if (answer === 'timeout')
      return `a container's connect to ${target} isn't refused, it times out`
  for (const [, target, answer] of result('host'))
    if (answer === 'open')
      return `a container on the wall's network reaches the docker host's own services at ${target}, through its network's gateway`
  for (const [, name, answer] of result('dns'))
    if (!/^[A-Z_]+$/.test(answer ?? '')) return `a container on the wall's network resolves ${name}`
  const anonymous = result('anonymous')[0]?.slice(1).join(' ')
  const token = result('token')[0]?.slice(1).join(' ')
  if (!anonymous?.startsWith('HTTP/1.1 407') || !token?.startsWith('HTTP/1.1 403'))
    return `the forwarder doesn't pass to awaywork's proxy at ${forwarded} (without the token: ${anonymous ?? 'nothing'}, with it: ${token ?? 'nothing'}); allow docker's bridge to that address if a firewall such as ufw drops it, and know that a remote DOCKER_HOST or a rootless docker isn't supported`
}

/**
 * Puts launch containers behind awaywork's proxy: an internal docker network, which has no route out and answers no DNS
 * for outside names, and one forwarder container on it and on the default bridge, the only way out, to the proxy on the host.
 * The proxy answers only with the token. Throws with the fix where it can't be set up or doesn't hold.
 */
export async function raiseContainerWall(egress: Egress): Promise<ContainerWall> {
  await lowerContainerWall()
  await sweep()
  await ensureImage()
  const token = randomBytes(16).toString('hex')
  const listen = (host: string) => egress.expose(host, token)
  const candidate = await bridgeGateway()
  // The bridge's gateway is ours to bind on a Linux host; elsewhere (Docker Desktop, Colima, a remote engine) it isn't an address here.
  let gateway = candidate
  let exposed = candidate
    ? await listen(candidate).catch((e: NodeJS.ErrnoException) => {
        if (e.code !== 'EADDRNOTAVAIL')
          throw unwalled(
            `can't listen for the forwarder on ${candidate}: ${e.message}; free that address`,
          )
        gateway = undefined
      })
    : undefined
  exposed ??= await listen('127.0.0.1').catch((e: Error) => {
    throw unwalled(`can't listen for the forwarder on 127.0.0.1: ${e.message}`)
  })
  const network = `awaywork-wall-${randomBytes(4).toString('hex')}`
  const forwarder = `${network}-forwarder`
  const label = ['--label', `${LABEL}=${owner()}`]
  const made = await docker([
    'network',
    'create',
    '--internal',
    '--ipv6=false',
    '-o',
    'com.docker.network.bridge.inhibit_ipv4=true',
    ...label,
    network,
  ])
  if (made.failed) {
    exposed.close()
    throw unwalled(`can't create its network: ${firstLine(made)}; docker must be running`)
  }
  const wall: Raised = { network, forwarder, exposed, env: proxyEnv(FORWARDER_PORT, ALIAS, token) }
  raised = wall
  if (!hooked) {
    hooked = true
    process.on('exit', () => {
      if (raised) removeSync(raised)
    })
  }
  const fail = async (reason: string) => {
    await lowerContainerWall()
    throw unwalled(reason)
  }
  const started = await docker([
    'run',
    '-d',
    '--name',
    forwarder,
    ...label,
    ...flags(network),
    '--network-alias',
    ALIAS,
    '--add-host',
    `host.docker.internal:${gateway ?? 'host-gateway'}`,
    WALL_IMAGE,
    'node',
    '-e',
    FORWARDER,
    'host.docker.internal',
    String(exposed.port),
  ])
  if (started.failed) return fail(`the forwarder didn't start: ${firstLine(started)}`)
  const joined = await docker(['network', 'connect', 'bridge', forwarder])
  if (joined.failed)
    return fail(`the forwarder can't join docker's default network: ${firstLine(joined)}`)
  const canary = `${network}-canary`
  let hostPort: number
  let gateways: string[]
  try {
    gateways = await networkGateways(network)
    hostPort = await startCanary(canary, label)
  } catch (e) {
    await docker(['rm', '-f', canary])
    await lowerContainerWall()
    throw e
  }
  const targets = [
    ...(gateway ? [OUTSIDE, `${gateway}:${exposed.port}`] : [OUTSIDE]),
    ...gateways.flatMap((address) => [`host=${address}:${hostPort}`, `host=${address}:22`]),
  ]
  const [seen, control] = await Promise.all([
    docker([
      'run',
      '--rm',
      ...flags(network),
      WALL_IMAGE,
      'node',
      '-e',
      PROBE,
      ALIAS,
      token,
      ...targets,
    ]),
    docker([
      'run',
      '--rm',
      ...flags(),
      WALL_IMAGE,
      'node',
      '-e',
      CONTROL,
      candidate ?? '',
      String(hostPort),
    ]),
  ])
  await docker(['rm', '-f', canary])
  if (seen.failed) return fail(`the probe didn't run: ${firstLine(seen)}`)
  const problem = probeProblem(
    seen.stdout,
    control.failed ? '' : control.stdout,
    `${gateway ?? 'the host'}:${exposed.port}`,
  )
  if (problem) return fail(problem)
  return wall
}

function removeSync({ forwarder, network, exposed }: Raised): void {
  exposed.close()
  spawnSync(bin('docker'), ['rm', '-f', forwarder], { timeout: 10_000 })
  spawnSync(bin('docker'), ['network', 'rm', network], { timeout: 10_000 })
}

/** Takes down the wall this process raised, if any: the proxy's listener, the forwarder and the network. */
export async function lowerContainerWall(): Promise<void> {
  const wall = raised
  raised = undefined
  if (!wall) return
  wall.exposed.close()
  await docker(['rm', '-f', wall.forwarder])
  await docker(['network', 'rm', wall.network])
}
