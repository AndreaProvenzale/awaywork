import type { LookupAddress } from 'node:dns'
import { lookup } from 'node:dns/promises'
import { createServer, request } from 'node:http'
import { BlockList, connect, isIP, type LookupFunction, type Socket } from 'node:net'
import { withholdsGrants } from './trust'
import type { Job, McpServer, Provider, Unit } from './types'

/** The hosts one phase of a unit may reach through the proxy; its refusals go to `log`. */
export interface Phase {
  name: 'setup' | 'check' | 'agent'
  hosts: string[]
  log(line: string): void
}

/** What a package manager's install fetches: registries, and GitHub for git dependencies. */
export const SETUP_HOSTS = [
  'registry.npmjs.org',
  'registry.yarnpkg.com',
  'pypi.org',
  'files.pythonhosted.org',
  'proxy.golang.org',
  'sum.golang.org',
  'crates.io',
  'static.crates.io',
  'index.crates.io',
  'rubygems.org',
  'github.com',
  'codeload.github.com',
  'objects.githubusercontent.com',
  'release-assets.githubusercontent.com',
]

/** `*` is every host, `*.x` the subdomains of x and not x itself, anything else that host. */
export const hostAllowed = (host: string, hosts: string[]) => {
  const name = host.toLowerCase()
  return hosts.some((entry) => {
    const allowed = entry.toLowerCase()
    return (
      allowed === '*' ||
      allowed === name ||
      (allowed.startsWith('*.') && name.endsWith(allowed.slice(1)))
    )
  })
}

/** The unit's `network`, none on work an author off `trust` brought in. */
export const grantedNetwork = (unit: Pick<Unit, 'network' | 'untrusted' | 'untrustedText'>) =>
  withholdsGrants(unit) ? [] : (unit.network ?? [])

export const setupPhase = (network: string[] = [], log: Phase['log']): Phase => ({
  name: 'setup',
  hosts: [...SETUP_HOSTS, ...network],
  log,
})

export const checkPhase = (network: string[] = [], log: Phase['log']): Phase => ({
  name: 'check',
  hosts: network,
  log,
})

/** The agent CLI's vendor, the hosts of the unit's HTTP MCP servers and the stdio ones' `network`, and the unit's `network`; on an untrusted author's PR or issue only the vendor's. */
export function agentPhase(provider: Pick<Provider, 'hosts'>, job: Job, log: Phase['log']): Phase {
  const servers: McpServer[] = Object.values(job.mcp ?? {})
  const mcp = servers.flatMap((s) => [
    ...(s.url ? [new URL(s.url).hostname] : []),
    ...(s.network ?? []),
  ])
  return {
    name: 'agent',
    hosts: [...new Set([...provider.hosts, ...mcp, ...grantedNetwork(job.unit)])],
    log,
  }
}

const NO_PROXY = 'localhost,127.0.0.1,::1'

/** What points a launch at the proxy, in both cases tools read, and Node's `fetch` too. */
export function proxyEnv(port: number): Record<string, string> {
  const url = `http://127.0.0.1:${port}`
  return Object.fromEntries([
    ['NODE_USE_ENV_PROXY', '1'],
    ...['HTTPS_PROXY', 'HTTP_PROXY', 'NO_PROXY'].flatMap((name) => {
      const value = name === 'NO_PROXY' ? NO_PROXY : url
      return [
        [name, value],
        [name.toLowerCase(), value],
      ]
    }),
  ])
}

const linkLocalRanges = new BlockList()
linkLocalRanges.addSubnet('169.254.0.0', 16, 'ipv4')
linkLocalRanges.addSubnet('fe80::', 10, 'ipv6')

/** Link-local addresses: 169.254.0.0/16, where clouds keep their metadata service, and fe80::/10; IPv4-mapped forms too. */
export const linkLocal = (address: string) => {
  const family = isIP(address)
  return family !== 0 && linkLocalRanges.check(address, family === 6 ? 'ipv6' : 'ipv4')
}

const LINK_LOCAL = 'link-local address'

const publicAddresses = async (name: string, options: object) => {
  const found = await lookup(name, { ...options, all: true })
  const kept = found.filter(({ address }) => !linkLocal(address))
  if (!kept.length) throw new Error(LINK_LOCAL)
  return kept
}

/** `dns.lookup` that answers none of the link-local addresses a name has. */
const publicLookup: LookupFunction = (name, options, done) => {
  publicAddresses(name, options).then(
    (kept) => {
      if (options.all) (done as (e: null, a: LookupAddress[]) => void)(null, kept)
      else done(null, kept[0]?.address ?? '', kept[0]?.family)
    },
    (error) => done(error, '', 4),
  )
}

export interface Egress {
  port: number
  /** The phase that runs now, or none. A launch is always in the one phase running: units take turns. */
  use(phase?: Phase): void
}

/** A forward proxy on loopback that connects only to the hosts of the current phase: CONNECT for HTTPS, absolute URIs for HTTP. */
export async function startEgress(): Promise<Egress> {
  let phase: Phase | undefined
  const told = new Set<string>()
  const refuse = (host: string, port: number) => {
    const shown = isIP(host) === 6 ? `[${host}]` : host
    const line = `network: refused ${shown}:${port} (${phase?.name ?? 'no phase'})`
    if (!told.has(line)) phase?.log(line)
    told.add(line)
  }
  const permits = (host: string, port: number) => {
    if (phase && hostAllowed(host, phase.hosts) && !linkLocal(host)) return true
    refuse(host, port)
    return false
  }
  const lookupFor =
    (host: string, port: number): LookupFunction =>
    (name, options, done) =>
      publicLookup(name, options, (error, ...rest) => {
        if (error?.message === LINK_LOCAL) refuse(host, port)
        ;(done as (...args: unknown[]) => void)(error, ...rest)
      })
  const server = createServer((req, res) => {
    const url = URL.parse(req.url ?? '')
    if (!url?.hostname) return void res.writeHead(400).end()
    const host = url.hostname.replace(/^\[|\]$/g, '')
    const port = Number(url.port) || 80
    if (!permits(host, port)) return void res.writeHead(403).end('awaywork: host not allowed\n')
    const upstream = request(
      {
        host,
        port,
        method: req.method,
        path: url.pathname + url.search,
        headers: req.headers,
        lookup: lookupFor(host, port),
      },
      (answer) => {
        res.writeHead(answer.statusCode ?? 502, answer.headers)
        answer.pipe(res)
      },
    )
    upstream.on('error', () => res.destroy())
    req.pipe(upstream)
  })
  server.on('connect', (req, client: Socket, head) => {
    const [, host = '', port = '443'] = /^\[?([^\]]*?)\]?(?::(\d+))?$/.exec(req.url ?? '') ?? []
    const number = Number(port)
    if (!Number.isInteger(number) || number < 1 || number > 65535)
      return void client.end('HTTP/1.1 400 Bad Request\r\n\r\n')
    if (!permits(host, number)) return void client.end('HTTP/1.1 403 Forbidden\r\n\r\n')
    const upstream = connect({ host, port: number, lookup: lookupFor(host, number) }, () => {
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n')
      upstream.write(head)
      upstream.pipe(client)
      client.pipe(upstream)
    })
    for (const [a, b] of [
      [upstream, client],
      [client, upstream],
    ] as const) {
      a.on('error', () => b.destroy())
      a.on('close', () => b.destroy())
    }
  })
  server.on('clientError', (_, socket) => socket.destroy())
  await new Promise<void>((ready) => server.listen(0, '127.0.0.1', ready))
  server.unref()
  const address = server.address()
  return {
    port: typeof address === 'object' && address ? address.port : 0,
    use(next) {
      phase = next
      told.clear()
    },
  }
}

let shared: Egress | undefined
/** The one proxy of the process, started at the first call. */
export async function sharedEgress(): Promise<Egress> {
  shared ??= await startEgress()
  return shared
}
