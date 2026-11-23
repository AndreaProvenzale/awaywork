import { spawnSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
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

/** Prints what a container on the wall's network reaches; argv: the forwarder's alias, the token, then direct targets. */
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
    ...targets.map(async (t) => ['direct', t, await tcp(t.slice(0, t.lastIndexOf(':')), t.slice(t.lastIndexOf(':') + 1))]),
    via(false).then((answer) => ['anonymous', answer]),
    via(true).then((answer) => ['token', answer]),
  ])
  for (const name of ['registry.npmjs.org', 'host.docker.internal']) seen.push(['dns', name, await lookup(name)])
  for (const line of seen) console.log(line.join(' '))
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
      .filter(([name, pid]) => name && !alive(Number(pid)))
      .map(([name]) => name as string)
  }
  const containers = await owned(['ps', '-a'], 'Names')
  if (containers.length) await docker(['rm', '-f', ...containers])
  for (const network of await owned(['network', 'ls'], 'Name'))
    await docker(['network', 'rm', network])
}

/** The host's address on docker's default bridge: where a Linux container reaches the host. */
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

async function ensureImage(): Promise<void> {
  if (!(await docker(['image', 'inspect', WALL_IMAGE])).failed) return
  const pulled = await docker(['pull', '--quiet', WALL_IMAGE], 10 * TIMEOUT_MS)
  if (pulled.failed)
    throw unwalled(`${WALL_IMAGE} isn't here and couldn't be pulled: ${firstLine(pulled)}`)
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
export function probeProblem(
  seen: string,
  outsideFromBridge: boolean,
  forwarded: string,
): string | undefined {
  if (!outsideFromBridge)
    return `can't tell: a container on docker's default network doesn't reach ${OUTSIDE} to compare with`
  const lines = seen.split('\n').map((line) => line.split(' '))
  const result = (kind: string) => lines.filter(([k]) => k === kind)
  for (const [, target, answer] of result('direct'))
    if (answer === 'open') return `a container on the wall's network reaches ${target} directly`
    else if (answer === 'timeout')
      return `a container's connect to ${target} isn't refused, it times out`
  for (const [, name, answer] of result('dns'))
    if (!/^[A-Z_]+$/.test(answer ?? '')) return `a container on the wall's network resolves ${name}`
  const anonymous = result('anonymous')[0]?.slice(1).join(' ')
  const token = result('token')[0]?.slice(1).join(' ')
  if (!anonymous?.startsWith('HTTP/1.1 407') || !token?.startsWith('HTTP/1.1 403'))
    return `the forwarder doesn't pass to awaywork's proxy at ${forwarded} (without the token: ${anonymous ?? 'nothing'}, with it: ${token ?? 'nothing'})`
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
  const gateway = process.platform === 'linux' ? await bridgeGateway() : undefined
  if (process.platform === 'linux' && !gateway)
    throw unwalled(
      "can't find the gateway of docker's default network, where the forwarder reaches the proxy",
    )
  const token = randomBytes(16).toString('hex')
  const exposed = await egress.expose(gateway ?? '127.0.0.1', token).catch((e: Error) => {
    throw unwalled(`can't listen for the forwarder on ${gateway ?? '127.0.0.1'}: ${e.message}`)
  })
  const network = `awaywork-wall-${randomBytes(4).toString('hex')}`
  const forwarder = `${network}-forwarder`
  const label = ['--label', `${LABEL}=${process.pid}`]
  const made = await docker(['network', 'create', '--internal', ...label, network])
  if (made.failed) {
    exposed.close()
    throw unwalled(`can't create its network: ${firstLine(made)}`)
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
  const targets = gateway ? [OUTSIDE, `${gateway}:${exposed.port}`] : [OUTSIDE]
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
      `require('net').connect({host: '1.1.1.1', port: 443, timeout: 3000}).on('connect', () => process.exit(0)).on('timeout', () => process.exit(1)).on('error', () => process.exit(1))`,
    ]),
  ])
  if (seen.failed) return fail(`the probe didn't run: ${firstLine(seen)}`)
  const problem = probeProblem(
    seen.stdout,
    !control.failed,
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
