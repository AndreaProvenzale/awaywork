import { once } from 'node:events'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile } from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { checkArgs, forward, servedRemotely, serveRemote } from '../src/cli/remote.js'
import { runsDir } from '../src/config/paths.js'

vi.mock('../src/config/paths.js', async (original) => {
  const { mkdtemp } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const state = await mkdtemp(`${tmpdir()}/awaywork-remote-`)
  return {
    ...(await original<typeof import('../src/config/paths.js')>()),
    runsDir: `${state}/runs`,
  }
})

const refused = (argv: unknown) => {
  const checked = checkArgs(argv)
  return 'refused' in checked ? checked.refused : undefined
}

describe('the remote allowlist', () => {
  it('takes the commands the /away skill and pane call, with their flags in both forms', () => {
    for (const argv of [
      ['report', '--json'],
      ['report', '20261104-101500', '--unit', '3'],
      ['report', '--list'],
      ['report', '--skipped'],
      ['report', '--skipped=quota'],
      ['plan', '--json'],
      ['plan', '--why', 'github:acme/api#5'],
      ['plan', '--why=-c'],
      ['plan', '--repo', 'acme/*', '--rule=2', '--rules'],
      ['stats', '--json'],
      ['sources', 'github', '--json'],
      ['doctor', '--json'],
      ['schedule', 'status'],
      ['skip', 'github:acme/api#5', '--until', '2030-01-01', '--reason', 'not now'],
      ['unskip', 'github:acme/api#5'],
      ['approve', 'github:acme/api#5', 'ship', 'it'],
      ['run', '--unit', 'API-12'],
      ['run', '--unit=API-12'],
    ])
      expect(refused(argv), argv.join(' ')).toBeUndefined()
    expect(checkArgs(['report', '--skipped', 'quota', 'x'])).toEqual({
      command: 'report',
      args: ['x'],
      options: { '--skipped': 'quota' },
    })
  })

  it('refuses any other command, flag or extra argument, naming it', () => {
    expect(refused(['init'])).toBe('init')
    expect(refused(['config', 'show'])).toBe('config')
    expect(refused(['schedule', 'install'])).toBe('schedule install')
    expect(refused(['replay', 'x'])).toBe('replay')
    expect(refused(['watch'])).toBe('watch')
    expect(refused([])).toBe('no command')
    expect(refused(['-c', '/tmp/evil.yml', 'plan'])).toBe('-c')
    expect(refused(['plan', '--config', '/tmp/evil.yml'])).toBe('--config')
    expect(refused(['plan', '--config=/tmp/evil.yml'])).toBe('--config=/tmp/evil.yml')
    expect(refused(['plan', '--help'])).toBe('--help')
    expect(refused(['plan', '--', '-c', 'x'])).toBe('--')
    expect(refused(['report', '--json=1'])).toBe('--json=1')
    expect(refused(['plan', 'extra'])).toBe('extra')
    expect(refused(['skip', 'a', 'b'])).toBe('b')
    expect(refused(['run'])).toBe('run without --unit <key>')
    expect(refused(['run', '--dry-run', '--unit', 'x'])).toBe('--dry-run')
    expect(refused('plan')).toBe('args, which must be an array of strings')
    expect(refused(['plan', 1])).toBe('args, which must be an array of strings')
  })

  it("never lets a flag's value look like a flag, which commander would read as the global -c", () => {
    expect(refused(['plan', '--why', '-c', '/tmp/evil.yml'])).toBe('--why -c: write it --why=-c')
    expect(refused(['approve', 'github:a/b#1', '-c/tmp/evil.yml'])).toBe('-c/tmp/evil.yml')
  })

  it('sends a served command to the remote even with a flag it refuses; help and the rest run here', () => {
    for (const argv of [
      ['plan'],
      ['skip', 'chores:CH-2', '--reason', '-- see thread'],
      ['plan', '--config', 'other.yml'],
      ['run', '--dry-run', '--unit', 'CH-1'],
      ['run', '--unit=CH-1', 'extra'],
    ])
      expect(servedRemotely(argv), argv.join(' ')).toBe(true)
    for (const argv of [
      ['plan', '--help'],
      ['skip', 'x', '-h'],
      ['run'],
      ['run', '--dry-run'],
      ['init'],
      ['schedule', 'install'],
      ['-c', 'other.yml', 'plan'],
      ['--version'],
    ])
      expect(servedRemotely(argv), argv.join(' ')).toBe(false)
  })
})

const TOKEN = 'a'.repeat(40)
const servers: Server[] = []
const closeAll = () => {
  for (const server of servers.splice(0)) {
    server.close()
    server.closeAllConnections()
  }
}
afterEach(closeAll)

/** Serves on a free port, with a stand-in CLI printing its argv and whether it sees the remote's env. */
async function serve(cli = 'console.log(JSON.stringify(process.argv.slice(1)))', timeout?: number) {
  const log: string[] = []
  const runUnit = vi.fn(async (key: string) => ({ stdout: `Queued ${key}\n`, stderr: '', code: 0 }))
  const server = serveRemote(
    { token: TOKEN },
    {
      config: '/daemon/config.yml',
      log: (line) => log.push(line),
      runUnit,
      cli: [process.execPath, '-e', cli, '--'],
      port: 0,
      timeout,
    },
  ) as Server
  servers.push(server)
  await vi.waitFor(() =>
    expect(log).toEqual([
      expect.stringMatching(/^remote: serving the CLI on port \d+(, 127.0.0.1 only)?$/),
    ]),
  )
  log.splice(0)
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  const post = (body: unknown, token = TOKEN) =>
    fetch(`${url}/cli`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}` },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    })
  return { url, log, runUnit, post }
}

describe('the daemon serving the CLI', () => {
  it('opens no port without a token, with a short one, or where AWAYWORK_REMOTE is set', () => {
    const log: string[] = []
    const s = { config: 'c', log: (l: string) => log.push(l), runUnit: vi.fn() }
    expect(serveRemote({}, s)).toBeUndefined()
    expect(serveRemote({ token: 'short' }, s)).toBeUndefined()
    expect(serveRemote({ token: TOKEN, url: 'https://x' }, s)).toBeUndefined()
    expect(log).toEqual([
      'remote: AWAYWORK_REMOTE_TOKEN is shorter than 32 characters, so no port is open; openssl rand -hex 32 makes one',
      'remote: AWAYWORK_REMOTE is set, so this machine forwards to it and opens no port',
    ])
  })

  it('runs an allowed call with its own config, the argv as given and no shell, the remote env blank', async () => {
    vi.stubEnv('AWAYWORK_REMOTE', 'https://away.example.com')
    vi.stubEnv('AWAYWORK_REMOTE_TOKEN', TOKEN)
    const pwned = join(await mkdtemp(join(tmpdir(), 'awaywork-pwned-')), 'pwned')
    const { post, log } = await serve(
      'console.log(JSON.stringify(process.argv.slice(1))); console.error(JSON.stringify([process.env.AWAYWORK_REMOTE, process.env.AWAYWORK_REMOTE_TOKEN])); process.exit(3)',
    )
    const why = `x; touch ${pwned} $(touch ${pwned}) \`touch ${pwned}\` | touch ${pwned}`
    const res = await post({ args: ['plan', '--why', why] })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      stdout: `${JSON.stringify(['--config', '/daemon/config.yml', 'plan', '--why', why])}\n`,
      stderr: '["",""]\n',
      code: 3,
    })
    expect(existsSync(pwned)).toBe(false)
    expect(log).toEqual([`remote: ${JSON.stringify(['plan', '--why', why])}: exit 3`])
    vi.unstubAllEnvs()
  })

  it('answers 404, 401, 413, 400 and 403 as the request asks, logging each without the token', async () => {
    const { url, post, log } = await serve()
    expect((await fetch(`${url}/cli`)).status).toBe(404)
    expect((await fetch(`${url}/other`, { method: 'POST' })).status).toBe(404)
    expect((await post({ args: ['plan'] }, 'b'.repeat(40))).status).toBe(401)
    expect((await post({ args: ['plan', 'x'.repeat(20_000)] })).status).toBe(413)
    expect((await post('{')).status).toBe(400)
    const res = await post({ args: ['plan', '--config', '/tmp/evil.yml'] })
    expect([res.status, await res.json()]).toEqual([403, { error: 'refused --config' }])
    const report = await post({ args: ['report', '../../etc'] })
    expect([report.status, await report.json()]).toEqual([
      403,
      { error: 'no run ../../etc; awaywork report --list lists them' },
    ])
    expect(log).toEqual([
      'remote: 401, wrong token',
      'remote: 413, body too big',
      'remote: 400, not JSON',
      'remote: ["plan","--config","/tmp/evil.yml"]: 403, --config',
      'remote: ["report","../../etc"]: 403, no run ../../etc',
    ])
    expect(log.join('\n')).not.toContain(TOKEN)
  })

  it("reads a run's report by an id it has, and queues run --unit in the daemon", async () => {
    await mkdir(join(runsDir, '20261104-101500'), { recursive: true })
    const { post, runUnit } = await serve()
    expect((await post({ args: ['report', '20261104-101500'] })).status).toBe(200)
    const res = await post({ args: ['run', '--unit', 'API-12'] })
    expect(await res.json()).toEqual({ stdout: 'Queued API-12\n', stderr: '', code: 0 })
    expect(runUnit).toHaveBeenCalledWith('API-12')
  })

  it('listens on localhost only, but on every interface in the image, for its proxy', async () => {
    const address = () => (servers.at(-1)?.address() as AddressInfo | undefined)?.address
    await serve()
    expect(address()).toBe('127.0.0.1')
    vi.stubEnv('AWAYWORK_IMAGE', '1')
    await serve()
    expect(address()).toMatch(/^(::|0\.0\.0\.0)$/)
    vi.unstubAllEnvs()
  })

  it('kills what the command started once it times out', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'awaywork-hung-'))
    const pid = join(dir, 'pid')
    const { post } = await serve(
      `const c = require('node:child_process').spawn('sleep', ['30']); require('node:fs').writeFileSync(${JSON.stringify(pid)}, String(c.pid)); setTimeout(() => {}, 30000)`,
      500,
    )
    const res = await post({ args: ['stats'] })
    expect((await res.json()).stderr).toBe(`timed out after ${500 / 60_000} minutes\n`)
    const sleeping = Number(await readFile(pid, 'utf8'))
    await vi.waitFor(() => expect(() => process.kill(sleeping, 0)).toThrow())
  })

  it('turns a third command away while two run', async () => {
    const { post } = await serve('setTimeout(() => {}, 1000)')
    const slow = [post({ args: ['stats'] }), post({ args: ['stats'] })]
    await new Promise((r) => setTimeout(r, 200))
    expect((await post({ args: ['stats'] })).status).toBe(429)
    expect((await Promise.all(slow)).map((r) => r.status)).toEqual([200, 200])
  })
})

describe('the CLI forwarding to a remote', () => {
  const output = () => {
    const out = { stdout: '', stderr: '' }
    vi.spyOn(process.stdout, 'write').mockImplementation((s) => {
      out.stdout += s
      return true
    })
    vi.spyOn(process.stderr, 'write').mockImplementation((s) => {
      out.stderr += s
      return true
    })
    vi.spyOn(console, 'error').mockImplementation((s) => {
      out.stderr += `${s}\n`
    })
    return out
  }
  afterEach(() => vi.restoreAllMocks())

  it("prints the remote's output as it came and exits with its code", async () => {
    const { url } = await serve('console.log("out"); console.error("err"); process.exit(2)')
    const out = output()
    expect(await forward(['stats'], { url: `${url}/`, token: TOKEN })).toBe(2)
    expect(out).toEqual({ stdout: 'out\n', stderr: 'err\n' })
  })

  it('fails in one line naming AWAYWORK_REMOTE on a wrong token, a refusal or no daemon', async () => {
    const { url } = await serve()
    const out = output()
    expect(await forward(['stats'], { url, token: 'wrong' })).toBe(1)
    expect(await forward(['plan', '--config', 'x'], { url, token: TOKEN })).toBe(1)
    const free = createServer().listen(0)
    await once(free, 'listening')
    const port = (free.address() as AddressInfo).port
    free.close()
    const gone = `http://127.0.0.1:${port}`
    expect(await forward(['stats'], { url: gone, token: TOKEN })).toBe(1)
    expect(out.stderr).toBe(
      [
        `AWAYWORK_REMOTE (${url}) refused AWAYWORK_REMOTE_TOKEN`,
        `AWAYWORK_REMOTE (${url}): refused --config`,
        `can't reach AWAYWORK_REMOTE (${gone}): connect ECONNREFUSED 127.0.0.1:${port}`,
        '',
      ].join('\n'),
    )
  })
})
