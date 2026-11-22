import { createServer, request } from 'node:http'
import { connect, type Socket } from 'node:net'
import type { Job, McpServer, Provider } from './types'

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

/** The agent CLI's vendor, the hosts of the unit's HTTP MCP servers and the stdio ones' `network`, and the unit's `network`; on an untrusted author's PR only the vendor's. */
export function agentPhase(provider: Pick<Provider, 'hosts'>, job: Job, log: Phase['log']): Phase {
  const servers: McpServer[] = Object.values(job.mcp ?? {})
  const mcp = servers.flatMap((s) => [
    ...(s.url ? [new URL(s.url).hostname] : []),
    ...(s.network ?? []),
  ])
  const network = job.unit.untrusted ? [] : (job.unit.network ?? [])
  return { name: 'agent', hosts: [...new Set([...provider.hosts, ...mcp, ...network])], log }
}

const NO_PROXY = 'localhost,127.0.0.1,::1'

/** What points a launch at the proxy, in both cases tools read. */
export function proxyEnv(port: number): Record<string, string> {
  const url = `http://127.0.0.1:${port}`
  return Object.fromEntries(
    ['HTTPS_PROXY', 'HTTP_PROXY', 'NO_PROXY'].flatMap((name) => {
      const value = name === 'NO_PROXY' ? NO_PROXY : url
      return [
        [name, value],
        [name.toLowerCase(), value],
      ]
    }),
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
  const permits = (host: string, port: number) => {
    if (phase && hostAllowed(host, phase.hosts)) return true
    const line = `network: refused ${host}:${port} (${phase?.name ?? 'no phase'})`
    if (!told.has(line)) phase?.log(line)
    told.add(line)
    return false
  }
  const server = createServer((req, res) => {
    const url = URL.parse(req.url ?? '')
    if (!url?.hostname) return void res.writeHead(400).end()
    const host = url.hostname.replace(/^\[|\]$/g, '')
    const port = Number(url.port) || 80
    if (!permits(host, port)) return void res.writeHead(403).end('awaywork: host not allowed\n')
    const upstream = request(
      { host, port, method: req.method, path: url.pathname + url.search, headers: req.headers },
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
    if (!permits(host, Number(port))) return void client.end('HTTP/1.1 403 Forbidden\r\n\r\n')
    const upstream = connect(Number(port), host, () => {
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
