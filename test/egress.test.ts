import { readFileSync } from 'node:fs'
import { createServer, request, type Server } from 'node:http'
import { type AddressInfo, connect as connectTo } from 'node:net'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { containerMode } from '#core/isolation/container'
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
} from '#core/isolation/egress'
import { isolateWalled, raiseWall, useMode, wallUp } from '#core/isolation/index'
import { none } from '#core/isolation/none'
import { userMode } from '#core/isolation/user'
import { wallFix, wallLines, wallProblem } from '#core/isolation/user-wall'
import type { Job, Provider, Unit } from '#core/types'
import { claude } from '#providers/claude'
import { codex } from '#providers/codex'
import { cursor } from '#providers/cursor'
import { shellRefusal } from '#providers/sandbox'

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
  it('gives setup the built-in registries plus network, and the repo’s own secrets', () => {
    const { hosts, name, secrets } = setupPhase(['npm.acme.internal'], log, ['NPM_TOKEN'])
    expect(name).toBe('setup')
    expect(secrets).toEqual(['NPM_TOKEN'])
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

  it('gives the agent its CLI, its MCP servers and network, and their secrets', () => {
    const mcp = {
      linear: { url: 'https://mcp.linear.app/mcp', secrets: ['LINEAR_TOKEN'] },
      sentry: { command: 'npx', secrets: ['SENTRY_TOKEN'], network: ['sentry.io'] },
      plain: { command: 'npx', secrets: [] },
    }
    const { hosts, name, secrets } = agentPhase(claude, job({ network: ['pypi.org'] }, mcp), log)
    expect(name).toBe('agent')
    expect(hosts).toEqual([...claude.hosts, 'mcp.linear.app', 'sentry.io', 'pypi.org'])
    expect(secrets).toEqual([...claude.secrets, 'LINEAR_TOKEN', 'SENTRY_TOKEN'])
    expect(secrets).toContain('CLAUDE_CODE_OAUTH_TOKEN')
  })

  it('gives the judge, an untrusted unit with no MCP servers, its CLI alone', () => {
    const judged = job({ untrusted: true, network: ['pypi.org'] })
    expect(agentPhase(claude, judged, log).hosts).toEqual(claude.hosts)
    expect(agentPhase(claude, judged, log).secrets).toEqual(claude.secrets)
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

describe('the proxy exposed to containers', () => {
  const via = (port: number, path: string, auth?: string) =>
    new Promise<number>((done, fail) => {
      const headers = auth ? { 'proxy-authorization': auth } : undefined
      const req = request({ host: '127.0.0.1', port, method: 'CONNECT', path, headers })
      req.on('connect', (res, socket) => {
        socket.destroy()
        done(res.statusCode ?? 0)
      })
      req.on('response', (res) => done(res.statusCode ?? 0))
      req.on('error', fail)
      req.end()
    })

  it('answers only with its token, on its own listener, the phases the same', async () => {
    const proxy = await startEgress()
    const exposed = await proxy.expose('127.0.0.1', 'secret')
    const origin = createServer((_, res) => res.end()).listen(0, '127.0.0.1')
    await new Promise((ready) => origin.once('listening', ready))
    const target = `127.0.0.1:${(origin.address() as AddressInfo).port}`
    const basic = (token: string) => `Basic ${Buffer.from(`awaywork:${token}`).toString('base64')}`
    try {
      proxy.use({ name: 'setup', hosts: ['127.0.0.1'], log: () => {} })
      expect(await via(exposed.port, target)).toBe(407)
      expect(await via(exposed.port, target, basic('guess'))).toBe(407)
      expect(await via(exposed.port, target, basic('secret'))).toBe(200)
      expect(await via(exposed.port, 'evil.example:443', basic('secret'))).toBe(403)
      expect(await via(proxy.port, target)).toBe(407)
      expect(await via(proxy.port, target, basic('secret'))).toBe(200)
      exposed.close()
      expect(await via(proxy.port, target)).toBe(200)
    } finally {
      exposed.close()
      origin.close()
    }
  })

  it('leaves the loopback listener open when the listen fails', async () => {
    const proxy = await startEgress()
    const origin = createServer((_, res) => res.end()).listen(0, '127.0.0.1')
    await new Promise((ready) => origin.once('listening', ready))
    const target = `127.0.0.1:${(origin.address() as AddressInfo).port}`
    try {
      proxy.use({ name: 'setup', hosts: ['127.0.0.1'], log: () => {} })
      await expect(proxy.expose('203.0.113.1', 'secret')).rejects.toThrow()
      expect(await via(proxy.port, target)).toBe(200)
    } finally {
      origin.close()
    }
  })

  it('keeps the token and the proxy headers from the origin of a plain HTTP request', async () => {
    const proxy = await startEgress()
    const exposed = await proxy.expose('127.0.0.1', 'secret')
    let seen: Record<string, unknown> = {}
    const origin = createServer((req, res) => {
      seen = req.headers
      res.end()
    }).listen(0, '127.0.0.1')
    await new Promise((ready) => origin.once('listening', ready))
    const port = (origin.address() as AddressInfo).port
    try {
      proxy.use({ name: 'setup', hosts: ['127.0.0.1'], log: () => {} })
      await new Promise<void>((done, fail) => {
        const req = request({
          host: '127.0.0.1',
          port: exposed.port,
          path: `http://127.0.0.1:${port}/`,
          headers: {
            'proxy-authorization': `Basic ${Buffer.from('awaywork:secret').toString('base64')}`,
            'proxy-connection': 'keep-alive',
            'x-kept': 'yes',
          },
        })
        req.on('response', (res) => res.resume().on('end', done))
        req.on('error', fail)
        req.end()
      })
      expect(seen['x-kept']).toBe('yes')
      expect(seen['proxy-authorization']).toBeUndefined()
      expect(seen['proxy-connection']).toBeUndefined()
    } finally {
      exposed.close()
      origin.close()
    }
  })

  it('takes the retry with the token on the connection that got the 407, as curl and git send it', async () => {
    const proxy = await startEgress()
    const exposed = await proxy.expose('127.0.0.1', 'secret')
    proxy.use({ name: 'setup', hosts: ['127.0.0.1'], log: () => {} })
    const origin = createServer((_, res) => res.end()).listen(0, '127.0.0.1')
    await new Promise((ready) => origin.once('listening', ready))
    const target = `127.0.0.1:${(origin.address() as AddressInfo).port}`
    const socket = connectTo(exposed.port, '127.0.0.1')
    const answers: string[] = []
    socket.on('data', (chunk) => answers.push(String(chunk).split('\r\n')[0] ?? ''))
    const token = Buffer.from('awaywork:secret').toString('base64')
    try {
      socket.write(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n\r\n`)
      await new Promise((tick) => setTimeout(tick, 100))
      socket.write(`CONNECT ${target} HTTP/1.1\r\nProxy-Authorization: Basic ${token}\r\n\r\n`)
      await new Promise((tick) => setTimeout(tick, 100))
      expect(answers).toEqual([
        'HTTP/1.1 407 Proxy Authentication Required',
        'HTTP/1.1 200 Connection Established',
      ])
    } finally {
      socket.destroy()
      exposed.close()
      origin.close()
    }
  })

  it('puts the token in the proxy URL, for the forwarder’s alias', () => {
    expect(proxyEnv(3128, 'awaywork-egress', 'abc').HTTPS_PROXY).toBe(
      'http://awaywork:abc@awaywork-egress:3128',
    )
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

  it('keeps the image’s script equal to the rules, as root, and walls Docker’s resolver', () => {
    const dockerfile = readFileSync('docker/Dockerfile', 'utf8')
    for (const rule of wallLines('awaywork').filter((l) => l.includes('tables')))
      expect(dockerfile).toContain(`${rule.replaceAll('sudo ', '')}\n`)
    expect(dockerfile).toContain('-d 127.0.0.11 -j REJECT\n')
    expect(readFileSync('docker/compose.yml', 'utf8')).toContain('- NET_ADMIN')
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

  it('names NET_ADMIN in the image for the problem wallProblem gives a worker that reaches out', async () => {
    const problem = await wallProblem('w', probes(reached, 'connect 0\nresolve 2'), address)
    expect(wallFix(problem as string, { AWAYWORK_IMAGE: '1' })).toContain('NET_ADMIN')
    expect(wallFix('w resolves names', { AWAYWORK_IMAGE: '1' })).toBeUndefined()
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

  it('is missing when the worker can write nscd’s socket', async () => {
    const worker = 'connect 1\nresolve 2\nsocket 1\ndbus 127'
    expect(await wallProblem('w', probes(reached, `${worker}\nnscd 0`), address)).toContain('nscd')
    expect(await wallProblem('w', probes(reached, `${worker}\nnscd 1`), address)).toBeUndefined()
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
    useMode(userMode('wall-user'))
    try {
      await expect(raiseWall({}, async () => 'no rules')).rejects.toThrow(/no rules/)
      expect(wallUp()).toBe(false)
      await raiseWall({}, async () => undefined)
      expect(wallUp()).toBe(true)
      await expect(raiseWall({}, async () => 'rules flushed')).rejects.toThrow(/rules flushed/)
      expect(wallUp()).toBe(false)
    } finally {
      useMode(none)
      await raiseWall({}, async () => undefined)
    }
  })

  it('refuses in awaywork’s image where the wall is missing, naming NET_ADMIN', async () => {
    useMode(userMode('wall-user'))
    try {
      await expect(
        raiseWall({ AWAYWORK_IMAGE: '1' }, async () => 'awaywork reaches x'),
      ).rejects.toThrow(/reaches x.*cap_add: \[NET_ADMIN\]/)
      expect(wallUp()).toBe(false)
      await expect(isolateWalled('none', {}, async () => 'no rules')).resolves.toBeUndefined()
    } finally {
      useMode(none)
    }
  })
})

describe('shellRefusal', () => {
  const withSandbox = (starts: boolean, base: Provider = claude): Provider => ({
    ...base,
    startsSandbox: async () => starts,
  })
  const bare: Provider = { ...claude, startsSandbox: undefined }
  const mine = { untrusted: false }
  const theirs = { untrusted: true }
  const behindWall = async (check: () => Promise<void>) => {
    useMode(userMode('wall-user'))
    try {
      await raiseWall({}, async () => undefined)
      await check()
    } finally {
      useMode(none)
      await raiseWall({}, async () => undefined)
    }
  }

  it('lets a unit run where its provider’s sandbox starts', async () => {
    expect(await shellRefusal(withSandbox(true), {}, mine)).toBeUndefined()
    expect(await shellRefusal(withSandbox(true), {}, theirs)).toBeUndefined()
  })

  it('refuses it, naming the fix, where the sandbox can’t start and no wall holds', async () => {
    const reason = await shellRefusal(withSandbox(false), {}, mine)
    expect(reason).toContain("claude's shell sandbox can't start here")
    expect(reason).toContain('bubblewrap, socat and user namespaces')
    expect(reason).toContain('isolation: user')
  })

  it('lets it run behind a wall that holds', async () => {
    await behindWall(async () => {
      expect(await shellRefusal(withSandbox(false), {}, mine)).toBeUndefined()
    })
  })

  it('refuses an untrusted author’s unit behind the wall too, where its shell could read the login', async () => {
    await behindWall(async () => {
      for (const unit of [theirs, { untrusted: false, untrustedText: true as const }])
        expect(await shellRefusal(withSandbox(false), {}, unit)).toBe(
          "claude's shell sandbox can't start here (needs bubblewrap, socat and user namespaces) and an author off `trust` steers this unit, so its shell could read CLAUDE_CODE_OAUTH_TOKEN: install them where units run",
        )
      expect(await shellRefusal(withSandbox(true), {}, theirs)).toBeUndefined()
      // Codex's shell reads its login with the sandbox up too.
      expect(await shellRefusal(withSandbox(false, codex), {}, theirs)).toContain(
        'steers this unit, so its shell could write outside the clone and reach the network',
      )
    })
  })

  it('refuses an untrusted author’s Cursor unit behind the wall, where its sandbox stays off', async () => {
    await behindWall(async () => {
      expect(await shellRefusal(withSandbox(true, cursor), {}, theirs)).toMatch(
        /^cursor's shell sandbox stays off behind awaywork's network wall, and an author off `trust`/,
      )
      expect(await shellRefusal(withSandbox(true, cursor), {}, mine)).toBeUndefined()
    })
    expect(await shellRefusal(withSandbox(true, cursor), {}, theirs)).toBeUndefined()
  })

  it('probes where it’s told the unit runs, and takes the wall it’s told', async () => {
    const seen: unknown[] = []
    const provider: Provider = {
      ...claude,
      startsSandbox: async (where) => {
        seen.push(where)
        return false
      },
    }
    expect(await shellRefusal(provider, { image: 'node:22' }, theirs, undefined, true)).toMatch(
      /steers this unit/,
    )
    expect(seen).toEqual([{ image: 'node:22' }])
    expect(await shellRefusal(provider, {}, mine, undefined, true)).toBeUndefined()
  })

  it('exempts a provider with no sandbox of its own', async () => {
    expect(await shellRefusal(bare, {}, mine)).toBeUndefined()
    expect(await shellRefusal(bare, {}, theirs)).toBeUndefined()
  })

  it('refuses under isolation: container while its wall is down', async () => {
    useMode(containerMode())
    try {
      expect(await shellRefusal(withSandbox(false), {}, mine)).toMatch(/no network wall holds/)
    } finally {
      useMode(none)
    }
  })

  it('refuses in awaywork’s image too', async () => {
    const before = process.env.AWAYWORK_IMAGE
    process.env.AWAYWORK_IMAGE = '1'
    try {
      expect(await shellRefusal(withSandbox(false), {}, mine)).toContain("can't start here")
    } finally {
      if (before === undefined) delete process.env.AWAYWORK_IMAGE
      else process.env.AWAYWORK_IMAGE = before
    }
  })
})
