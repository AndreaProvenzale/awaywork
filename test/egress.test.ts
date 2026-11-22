import { readFileSync } from 'node:fs'
import { createServer, request, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  agentPhase,
  checkPhase,
  type Egress,
  hostAllowed,
  proxyEnv,
  SETUP_HOSTS,
  setupPhase,
  startEgress,
} from '#core/egress'
import { containerize, shellRefusal, wallHolds, wallLines } from '#core/isolation'
import type { Job, Provider } from '#core/types'
import { claude } from '#providers/claude'
import { codex } from '#providers/codex'
import { cursor } from '#providers/cursor'

describe('hostAllowed', () => {
  it('matches a host exactly, a wildcard on subdomains only, and * on everything', () => {
    expect(hostAllowed('npmjs.org', ['npmjs.org'])).toBe(true)
    expect(hostAllowed('registry.npmjs.org', ['npmjs.org'])).toBe(false)
    expect(hostAllowed('a.b.npmjs.org', ['*.npmjs.org'])).toBe(true)
    expect(hostAllowed('npmjs.org', ['*.npmjs.org'])).toBe(false)
    expect(hostAllowed('evilnpmjs.org', ['*.npmjs.org'])).toBe(false)
    expect(hostAllowed('anything.example', ['*'])).toBe(true)
    expect(hostAllowed('Registry.NPMJS.org', ['registry.npmjs.org'])).toBe(true)
    expect(hostAllowed('x.org', [])).toBe(false)
  })
})

const job = (unit: object, mcp?: Job['mcp']) => ({ unit, mcp }) as unknown as Job
const log = () => {}

describe('phase lists', () => {
  it('gives setup the built-in registries plus network', () => {
    const { hosts, name } = setupPhase(['npm.acme.internal'], log)
    expect(name).toBe('setup')
    expect(hosts).toEqual([...SETUP_HOSTS, 'npm.acme.internal'])
    for (const host of [
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
    ])
      expect(hosts).toContain(host)
  })

  it('gives the checks network alone', () => {
    expect(checkPhase(['a.org'], log).hosts).toEqual(['a.org'])
    expect(checkPhase(undefined, log).hosts).toEqual([])
  })

  it('gives the agent its CLI, its MCP servers and network', () => {
    const mcp = {
      linear: { url: 'https://mcp.linear.app/mcp', secrets: [] },
      sentry: { command: 'npx', secrets: [], network: ['sentry.io'] },
      plain: { command: 'npx', secrets: [] },
    }
    const { hosts, name } = agentPhase(claude, job({ network: ['pypi.org'] }, mcp), log)
    expect(name).toBe('agent')
    expect(hosts).toEqual([...claude.hosts, 'mcp.linear.app', 'sentry.io', 'pypi.org'])
  })

  it('gives the judge, an untrusted unit with no MCP servers, its CLI alone', () => {
    const judged = job({ untrusted: true, network: ['pypi.org'] })
    expect(agentPhase(claude, judged, log).hosts).toEqual(claude.hosts)
    expect(agentPhase(codex, judged, log).hosts).toEqual([
      'chatgpt.com',
      'auth.openai.com',
      'api.openai.com',
    ])
    expect(agentPhase(cursor, judged, log).hosts.length).toBeGreaterThan(0)
  })
})

describe('proxyEnv', () => {
  it('sets both cases of the proxies, and loopback past them', () => {
    expect(proxyEnv(4321)).toEqual({
      HTTPS_PROXY: 'http://127.0.0.1:4321',
      https_proxy: 'http://127.0.0.1:4321',
      HTTP_PROXY: 'http://127.0.0.1:4321',
      http_proxy: 'http://127.0.0.1:4321',
      NO_PROXY: 'localhost,127.0.0.1,::1',
      no_proxy: 'localhost,127.0.0.1,::1',
    })
  })
})

describe('the proxy', () => {
  let origin: Server
  let proxy: Egress
  let originPort: number
  const lines: string[] = []
  const phase = (hosts: string[]) => ({
    name: 'setup' as const,
    hosts,
    log: (l: string) => lines.push(l),
  })

  beforeAll(async () => {
    origin = createServer((_, res) => res.end('hello')).listen(0, '127.0.0.1')
    await new Promise((ready) => origin.once('listening', ready))
    originPort = (origin.address() as AddressInfo).port
    proxy = await startEgress()
  })
  afterAll(() => void origin.close())

  /** A GET with the whole URL as the path, as a client sends it to a proxy. */
  const get = (host: string) =>
    new Promise<{ status: number; body: string }>((done, fail) => {
      const req = request(
        {
          host: '127.0.0.1',
          port: proxy.port,
          path: `http://${host}:${originPort}/`,
          headers: { host },
        },
        (res) => {
          let body = ''
          res.on('data', (c) => {
            body += c
          })
          res.on('end', () => done({ status: res.statusCode ?? 0, body }))
        },
      )
      req.on('error', fail)
      req.end()
    })

  const connect = (target: string) =>
    new Promise<number>((done, fail) => {
      const req = request({ host: '127.0.0.1', port: proxy.port, method: 'CONNECT', path: target })
      req.on('connect', (res, socket) => {
        socket.destroy()
        done(res.statusCode ?? 0)
      })
      req.on('response', (res) => done(res.statusCode ?? 0))
      req.on('error', fail)
      req.end()
    })

  it('passes plain HTTP to a host of the phase', async () => {
    proxy.use(phase(['127.0.0.1']))
    expect(await get('127.0.0.1')).toEqual({ status: 200, body: 'hello' })
  })

  it('opens a tunnel to a host of the phase, and refuses one outside it, once in the log', async () => {
    lines.length = 0
    proxy.use(phase(['127.0.0.1']))
    expect(await connect(`127.0.0.1:${originPort}`)).toBe(200)
    expect(await connect('evil.example:443')).toBe(403)
    expect(await connect('evil.example:443')).toBe(403)
    expect(lines).toEqual(['network: refused evil.example:443 (setup)'])
  })

  it('refuses plain HTTP outside the phase with a 403', async () => {
    lines.length = 0
    proxy.use(phase(['*.acme.test']))
    expect((await get('127.0.0.1')).status).toBe(403)
    expect(lines).toEqual([`network: refused 127.0.0.1:${originPort} (setup)`])
  })

  it('refuses everything between phases, and tells the next phase of a repeat afresh', async () => {
    proxy.use()
    expect(await connect(`127.0.0.1:${originPort}`)).toBe(403)
    lines.length = 0
    proxy.use(phase([]))
    await connect('evil.example:443')
    proxy.use(phase([]))
    await connect('evil.example:443')
    expect(lines).toHaveLength(2)
  })
})

describe('the wall', () => {
  it('has rules for IPv4 and IPv6 that leave loopback but its DNS, and keep the script of the action equal', () => {
    const lines = wallLines('awaywork-work')
    expect(lines).toHaveLength(8)
    expect(lines.slice(0, 4)).toEqual([
      'sudo iptables -I OUTPUT -m owner --uid-owner awaywork-work -j REJECT',
      'sudo iptables -I OUTPUT -m owner --uid-owner awaywork-work -o lo -j ACCEPT',
      'sudo iptables -I OUTPUT -m owner --uid-owner awaywork-work -o lo -p udp --dport 53 -j REJECT',
      'sudo iptables -I OUTPUT -m owner --uid-owner awaywork-work -o lo -p tcp --dport 53 -j REJECT',
    ])
    expect(lines.slice(4)).toEqual(lines.slice(0, 4).map((l) => l.replace('iptables', 'ip6tables')))
    const script = readFileSync('scripts/worker-user.sh', 'utf8')
    for (const line of wallLines('awaywork')) expect(script).toContain(`${line}\n`)
  })

  type Run = Parameters<typeof wallHolds>[1]
  const ran = (stdout: string, failed = false) =>
    (async () => ({ stdout, failed })) as unknown as Run

  it('holds when the worker reaches neither the outside nor the loopback resolver', async () => {
    expect(await wallHolds('wall-a', ran(''))).toBe(true)
  })

  it('is missing when the worker reaches one of them, or the probe itself fails', async () => {
    expect(await wallHolds('wall-b', ran('1.1.1.1:443\n'))).toBe(false)
    expect(await wallHolds('wall-c', ran('127.0.0.53:53\n'))).toBe(false)
    expect(await wallHolds('wall-d', ran('', true))).toBe(false)
  })

  it('probes once for each user', async () => {
    let calls = 0
    const run = (async () => {
      calls++
      return { stdout: '', failed: false }
    }) as unknown as Run
    await wallHolds('wall-e', run)
    await wallHolds('wall-e', run)
    expect(calls).toBe(1)
  })
})

describe('shellRefusal', () => {
  const withSandbox = (starts: boolean): Provider => ({
    ...claude,
    startsSandbox: async () => starts,
  })
  const none: Provider = { ...claude, startsSandbox: undefined }

  it('lets a unit run where its provider’s sandbox starts', async () => {
    expect(await shellRefusal(withSandbox(true), { dir: '/x' })).toBeUndefined()
  })

  it('refuses it, naming the fix, where the sandbox can’t start and no wall holds', async () => {
    const reason = await shellRefusal(withSandbox(false), { dir: '/x' })
    expect(reason).toContain("claude's shell sandbox can't start here")
    expect(reason).toContain('bubblewrap, socat and user namespaces')
    expect(reason).toContain('isolation: user')
  })

  it('exempts a provider with no sandbox of its own', async () => {
    expect(await shellRefusal(none, { dir: '/x' })).toBeUndefined()
  })

  it('exempts isolation: container', async () => {
    containerize(true)
    try {
      expect(await shellRefusal(withSandbox(false), { dir: '/x' })).toBeUndefined()
    } finally {
      containerize(false)
    }
  })

  it('exempts awaywork’s image', async () => {
    const before = process.env.AWAYWORK_IMAGE
    process.env.AWAYWORK_IMAGE = '1'
    try {
      expect(await shellRefusal(withSandbox(false), { dir: '/x' })).toBeUndefined()
    } finally {
      if (before === undefined) delete process.env.AWAYWORK_IMAGE
      else process.env.AWAYWORK_IMAGE = before
    }
  })
})
