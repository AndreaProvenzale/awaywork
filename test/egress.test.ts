import { readFileSync } from 'node:fs'
import { createServer, request, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  agentPhase,
  checkPhase,
  type Egress,
  grantedNetwork,
  hostAllowed,
  linkLocal,
  proxyEnv,
  SETUP_HOSTS,
  setupPhase,
  startEgress,
} from '#core/egress'
import { containerize, isolate } from '#core/isolation'
import type { Job, Provider, Unit } from '#core/types'
import { isolateWalled, raiseWall, shellRefusal, wallLines, wallProblem, wallUp } from '#core/wall'
import { claude } from '#providers/claude'
import { codex } from '#providers/codex'
import { cursor } from '#providers/cursor'

describe('linkLocal', () => {
  it('names 169.254.0.0/16 and fe80::/10, mapped IPv4 too', () => {
    for (const address of [
      '169.254.169.254',
      'fe80::1',
      'FEBF::1',
      '::ffff:169.254.1.1',
      '::ffff:a9fe:a9fe',
      '0:0:0:0:0:ffff:a9fe:a9fe',
    ])
      expect(linkLocal(address)).toBe(true)
    for (const address of ['169.253.0.1', '10.0.0.1', '::1', 'fec0::1', '1.1.1.1', 'github.com'])
      expect(linkLocal(address)).toBe(false)
  })
})

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

describe('grantedNetwork', () => {
  it('gives no network to work an author off trust brought in', () => {
    const granted = (unit: object) => grantedNetwork(unit as Unit)
    expect(granted({ network: ['a.org'] })).toEqual(['a.org'])
    expect(granted({ network: ['a.org'], untrusted: true })).toEqual([])
    expect(granted({ network: ['a.org'], untrustedText: true })).toEqual([])
    expect(granted({})).toEqual([])
  })
})

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
      'release-assets.githubusercontent.com',
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
  it('sets both cases of the proxies, Node’s too, and loopback past them', () => {
    expect(proxyEnv(4321)).toEqual({
      NODE_USE_ENV_PROXY: '1',
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

  it('refuses a port no host has without throwing, and goes on', async () => {
    proxy.use(phase(['github.com']))
    for (const port of ['99999', '0', '65536'])
      expect(await connect(`github.com:${port}`)).toBe(400)
    proxy.use(phase(['127.0.0.1']))
    expect(await connect(`127.0.0.1:${originPort}`)).toBe(200)
  })

  it('refuses link-local addresses even under *, brackets IPv6 in the log, and lets other ports through', async () => {
    lines.length = 0
    proxy.use(phase(['*']))
    expect(await connect('169.254.169.254:80')).toBe(403)
    expect(await connect('[fe80::1]:22')).toBe(403)
    expect(await connect('[::ffff:a9fe:a9fe]:80')).toBe(403)
    expect(await connect(`127.0.0.1:${originPort}`)).toBe(200)
    expect(lines).toEqual([
      'network: refused 169.254.169.254:80 (setup)',
      'network: refused [fe80::1]:22 (setup)',
      'network: refused [::ffff:a9fe:a9fe]:80 (setup)',
    ])
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
  it('has rules for IPv4 and IPv6 that leave loopback but its DNS, deny the resolver, and keep the script of the action equal', () => {
    const lines = wallLines('awaywork-work')
    const rules = lines.filter((l) => l.includes('tables'))
    expect(rules).toHaveLength(8)
    expect(rules.slice(0, 4).map((l) => l.split(' || ')[1])).toEqual([
      'sudo iptables -I OUTPUT -m owner --uid-owner awaywork-work -j REJECT',
      'sudo iptables -I OUTPUT -m owner --uid-owner awaywork-work -o lo -j ACCEPT',
      'sudo iptables -I OUTPUT -m owner --uid-owner awaywork-work -o lo -p udp --dport 53 -j REJECT',
      'sudo iptables -I OUTPUT -m owner --uid-owner awaywork-work -o lo -p tcp --dport 53 -j REJECT',
    ])
    expect(rules[0]).toContain(
      'sudo iptables -C OUTPUT -m owner --uid-owner awaywork-work -j REJECT 2> /dev/null ||',
    )
    expect(rules.slice(4)).toEqual(
      rules.slice(0, 4).map((l) => l.replaceAll('iptables', 'ip6tables')),
    )
    const resolver = lines.filter((l) => !l.includes('tables')).join('\n')
    expect(resolver).toContain('setfacl -m u:awaywork-work:--- /run/systemd/resolve')
    expect(resolver).toContain(
      'user="awaywork-work"><deny send_destination="org.freedesktop.resolve1"',
    )
    const script = readFileSync('scripts/worker-user.sh', 'utf8')
    for (const line of wallLines('awaywork')) expect(script).toContain(`${line}\n`)
  })

  type Run = NonNullable<Parameters<typeof wallProblem>[1]>
  /** A probe's answers: the first for awaywork's own uid, the second for the worker. */
  const probes = (control: string, worker: string, failed = false) =>
    (async (file: string) => ({
      stdout: file.endsWith('sudo') ? worker : control,
      failed: failed && file.endsWith('sudo'),
    })) as unknown as Run
  const reached = 'connect 0\nresolve 0'
  const address = async () => '140.82.121.6'

  it('holds when the worker is refused at once and resolves nothing', async () => {
    expect(await wallProblem('w', probes(reached, 'connect 1\nresolve 2'), address)).toBeUndefined()
  })

  it('is missing when the worker reaches the outside, resolves a name, or times out', async () => {
    expect(await wallProblem('w', probes(reached, 'connect 0\nresolve 2'), address)).toContain(
      'reaches',
    )
    expect(await wallProblem('w', probes(reached, 'connect 1\nresolve 0'), address)).toContain(
      'resolves names',
    )
    expect(await wallProblem('w', probes(reached, 'connect 124\nresolve 2'), address)).toContain(
      'times out',
    )
    expect(await wallProblem('w', probes(reached, '', true), address)).toContain('failed')
  })

  it('is missing when the worker can still open resolved’s socket or ask it over D-Bus', async () => {
    expect(
      await wallProblem('w', probes(reached, 'connect 1\nresolve 2\nsocket 0\ndbus 1'), address),
    ).toContain('socket')
    expect(
      await wallProblem('w', probes(reached, 'connect 1\nresolve 2\nsocket 1\ndbus 0'), address),
    ).toContain('D-Bus')
    expect(
      await wallProblem('w', probes(reached, 'connect 1\nresolve 2\nsocket 1\ndbus 127'), address),
    ).toBeUndefined()
  })

  describe('IPv6', () => {
    const v6 = (control: string, worker: string) =>
      (async (file: string, args: string[]) => {
        const six = JSON.stringify(args).includes('2606')
        const own = file.endsWith('sudo') ? 'connect 1\nresolve 2' : reached
        const stdout = six ? (file.endsWith('sudo') ? worker : control) : own
        return { stdout, failed: false }
      }) as unknown as Run

    it('is skipped where awaywork itself has no route out', async () => {
      expect(await wallProblem('w', v6('connect 1', 'connect 0'), address)).toBeUndefined()
    })

    it('needs the worker refused at once where awaywork has one', async () => {
      expect(await wallProblem('w', v6(reached, 'connect 1'), address)).toBeUndefined()
      expect(await wallProblem('w', v6(reached, 'connect 0'), address)).toContain('IPv6')
      expect(await wallProblem('w', v6(reached, 'connect 124'), address)).toContain('times out')
    })
  })

  it('proves nothing when awaywork itself reaches nothing: no wall, the outside blackholed', async () => {
    expect(
      await wallProblem('w', probes('connect 124\nresolve 0', 'connect 124\nresolve 2'), address),
    ).toContain("can't tell")
    expect(
      await wallProblem('w', probes(reached, 'connect 1\nresolve 2'), async () => {
        throw new Error('offline')
      }),
    ).toContain("can't tell")
  })

  it('probes again at every raise, so rules added or lost show at once', async () => {
    isolate('wall-user')
    try {
      await expect(raiseWall({}, async () => 'no rules')).rejects.toThrow(/no rules/)
      expect(wallUp()).toBe(false)
      await raiseWall({}, async () => undefined)
      expect(wallUp()).toBe(true)
      await expect(raiseWall({}, async () => 'rules flushed')).rejects.toThrow(/rules flushed/)
      expect(wallUp()).toBe(false)
    } finally {
      isolate(undefined)
      await raiseWall({}, async () => undefined)
    }
  })

  it('runs open in awaywork’s image where the wall is missing, and refuses everywhere else', async () => {
    isolate('wall-user')
    try {
      await raiseWall({ AWAYWORK_IMAGE: '1' }, async () => 'no rules')
      expect(wallUp()).toBe(false)
      await expect(isolateWalled('none', {}, async () => 'no rules')).resolves.toBeUndefined()
    } finally {
      isolate(undefined)
    }
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

  it('lets it run behind a wall that holds', async () => {
    isolate('wall-user')
    try {
      await raiseWall({}, async () => undefined)
      expect(await shellRefusal(withSandbox(false), { dir: '/x' })).toBeUndefined()
    } finally {
      isolate(undefined)
      await raiseWall({}, async () => undefined)
    }
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
