import { once } from 'node:events'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execa } from 'execa'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  checkArgs,
  forward,
  remoteCall,
  servedRemotely,
  serveRemote,
  shellQuote,
  sshArgs,
} from '../src/cli/remote.js'
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

  it('sends a served command to the remote even with a flag it refuses; help, a config and the rest run here', () => {
    for (const argv of [
      ['plan'],
      ['skip', 'chores:CH-2', '--reason', '-- see thread'],
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
      ['plan', '-c', 'other.yml'],
      ['plan', '-cother.yml'],
      ['plan', '-c=other.yml'],
      ['plan', '--config', 'other.yml'],
      ['skip', 'x', '--config=other.yml'],
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

/** A streamed answer, its lines' fields joined. */
async function streamed(res: Response) {
  const out = { stdout: '', stderr: '', code: undefined as number | undefined }
  for (const line of (await res.text()).split('\n').filter(Boolean)) {
    const { stdout = '', stderr = '', code } = JSON.parse(line)
    Object.assign(out, { stdout: out.stdout + stdout, stderr: out.stderr + stderr, code })
  }
  return out
}

/** Serves on a free port, with a stand-in CLI printing its argv and whether it sees the remote's env. */
async function serve(
  cli = 'console.log(JSON.stringify(process.argv.slice(1)))',
  timeout?: number,
  beat?: number,
) {
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
      beat,
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
    expect(await streamed(res)).toEqual({
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
    expect(await streamed(res)).toEqual({ stdout: 'Queued API-12\n', stderr: '', code: 0 })
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
      2500,
    )
    const res = await post({ args: ['stats'] })
    expect((await streamed(res)).stderr).toBe(`timed out after ${2500 / 60_000} minutes\n`)
    const sleeping = Number(await readFile(pid, 'utf8'))
    await vi.waitFor(() => expect(() => process.kill(sleeping, 0)).toThrow())
  })

  it('answers at once and streams the output as it comes, a line every beat while the command is quiet', async () => {
    const { post } = await serve(
      'console.log("fetching"); setTimeout(() => console.log("done"), 1000)',
      undefined,
      300,
    )
    const res = await post({ args: ['stats'] })
    expect(res.headers.get('content-type')).toBe('application/x-ndjson')
    const reader = (res.body as ReadableStream<Uint8Array>).getReader()
    const decoder = new TextDecoder()
    let body = ''
    while (!body.includes('fetching')) {
      const r = await reader.read()
      expect(r.done).toBe(false)
      body += decoder.decode(r.value)
    }
    expect(body).not.toContain('done')
    for (let r = await reader.read(); !r.done; r = await reader.read())
      body += decoder.decode(r.value)
    const lines = body.trim().split('\n')
    expect(lines.filter((l) => l !== '{}')).toEqual([
      '{"stdout":"fetching\\n"}',
      '{"stdout":"done\\n"}',
      '{"code":0}',
    ])
    const quiet = lines.slice(
      lines.indexOf('{"stdout":"fetching\\n"}'),
      lines.indexOf('{"stdout":"done\\n"}'),
    )
    expect(quiet.filter((l) => l === '{}').length).toBeGreaterThanOrEqual(2)
  })

  it('stops the command when the client leaves', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'awaywork-left-'))
    const pid = join(dir, 'pid')
    const { url, log } = await serve(
      `require('node:fs').writeFileSync(${JSON.stringify(pid)}, String(process.pid)); setTimeout(() => {}, 30000)`,
    )
    const left = new AbortController()
    const res = await fetch(`${url}/cli`, {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify({ args: ['stats'] }),
      signal: left.signal,
    })
    expect(res.status).toBe(200)
    await vi.waitFor(() => expect(existsSync(pid)).toBe(true))
    left.abort()
    const running = Number(await readFile(pid, 'utf8'))
    await vi.waitFor(() => expect(() => process.kill(running, 0)).toThrow())
    await vi.waitFor(() => expect(log).toEqual(['remote: ["stats"]: stopped, the client left']))
  })

  it('still queues a run --unit whose client left, logging its exit', async () => {
    const { url, log, runUnit } = await serve()
    runUnit.mockImplementation(async (key) => {
      await new Promise((r) => setTimeout(r, 300))
      return { stdout: `Queued ${key}\n`, stderr: '', code: 0 }
    })
    const left = new AbortController()
    const res = await fetch(`${url}/cli`, {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify({ args: ['run', '--unit', 'API-12'] }),
      signal: left.signal,
    })
    expect(res.status).toBe(200)
    left.abort()
    await vi.waitFor(() => expect(log).toEqual(['remote: ["run","--unit","API-12"]: exit 0']))
    expect(runUnit).toHaveBeenCalledWith('API-12')
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

  it('fails in one line naming AWAYWORK_REMOTE when the answer stops before an exit code', async () => {
    const cut = createServer((_, res) => {
      res.writeHead(200).write('{"stdout":"half"}\n')
      setTimeout(() => res.destroy(), 100)
    }).listen(0)
    servers.push(cut)
    await once(cut, 'listening')
    const url = `http://127.0.0.1:${(cut.address() as AddressInfo).port}`
    const out = output()
    expect(await forward(['stats'], { url, token: TOKEN })).toBe(1)
    expect(out.stdout).toBe('half')
    expect(out.stderr).toMatch(new RegExp(`^AWAYWORK_REMOTE \\(${url}\\) stopped answering: .+\n$`))
  })

  it("says a 200 that isn't awaywork's stream is not watch answering", async () => {
    const page = createServer((_, res) => res.writeHead(200).end('<!DOCTYPE html>\n')).listen(0)
    servers.push(page)
    await once(page, 'listening')
    const url = `http://127.0.0.1:${(page.address() as AddressInfo).port}`
    const out = output()
    expect(await forward(['stats'], { url, token: TOKEN })).toBe(1)
    expect(out.stderr).toBe(
      `AWAYWORK_REMOTE (${url}): answered HTTP 200, not as awaywork watch does\n`,
    )
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

  it('takes ssh:// and http(s):// remotes, an http one only with a token, and says so for anything else', async () => {
    const out = output()
    expect(remoteCall(['plan'], { url: 'https://away.example.com' })).toBeUndefined()
    expect(remoteCall(['plan', '--help'], { url: 'ssh://box' })).toBeUndefined()
    expect(remoteCall(['init'], { url: 'ssh://box' })).toBeUndefined()
    expect(remoteCall(['plan', '-c', 'x.yml'], { url: 'ssh://box' })).toBeUndefined()
    expect(await remoteCall(['plan'], { url: 'box', token: TOKEN })).toBe(1)
    expect(await remoteCall(['plan'], { url: 'ssh://' })).toBe(1)
    expect(out.stderr).toBe(
      'AWAYWORK_REMOTE (box) is neither ssh:// nor http(s)://\nAWAYWORK_REMOTE (ssh://) names no host\n',
    )
  })

  describe('over ssh', () => {
    const root = fileURLToPath(new URL('..', import.meta.url))
    const free = async () => {
      const server = createServer().listen(0)
      await once(server, 'listening')
      const { port } = server.address() as AddressInfo
      server.close()
      return `http://127.0.0.1:${port}`
    }

    /** A laptop with a stand-in ssh, which hands the command to sh as the box's login shell would, and a box with this awaywork, its env file holding `boxEnv`. */
    async function box(boxEnv = `AWAYWORK_REMOTE_TOKEN=${TOKEN}\n`) {
      const dir = await mkdtemp(join(tmpdir(), 'awaywork-ssh-'))
      const bin = join(dir, 'bin')
      const boxBin = join(dir, 'box-bin')
      const home = join(dir, 'box-home')
      await mkdir(join(home, '.config', 'awaywork'), { recursive: true })
      await mkdir(boxBin)
      await mkdir(bin)
      await writeFile(join(home, '.config', 'awaywork', 'env'), boxEnv)
      const ssh = `#!/bin/sh
while [ "$1" != -- ]; do shift; done
if [ "$2" = down ]; then echo "ssh: connect to host down port 22: Connection refused" >&2; exit 255; fi
exec env PATH="$BOX_PATH" sh -c "$3"
`
      // The box's daemon is on its own port here, not 7480.
      const awaywork = `#!/bin/sh
exec env AWAYWORK_REMOTE="$BOX_URL" HOME=${home} ${process.execPath} --experimental-transform-types --disable-warning=ExperimentalWarning --import ${root}scripts/ts-resolve.mjs ${root}src/cli/index.ts "$@"
`
      await writeFile(join(bin, 'ssh'), ssh, { mode: 0o755 })
      await writeFile(join(boxBin, 'awaywork'), awaywork, { mode: 0o755 })
      vi.stubEnv('PATH', `${bin}:${process.env.PATH}`)
      vi.stubEnv('BOX_PATH', `${boxBin}:/usr/bin:/bin`)
      return dir
    }
    afterEach(() => vi.unstubAllEnvs())

    it('runs ssh with no terminal nor prompt, the box user, host and port as the URL names them', () => {
      const command = `'env' 'AWAYWORK_REMOTE=http://127.0.0.1:7480' 'AWAYWORK_REMOTE_VIA=ssh://box' 'awaywork' 'plan' '--json'`
      expect(sshArgs('ssh://box', ['plan', '--json'])).toEqual([
        '-T',
        '-o',
        'BatchMode=yes',
        '--',
        'box',
        command,
      ])
      expect(sshArgs('ssh://me@box.example.com:2222', [])?.slice(3, -1)).toEqual([
        '-p',
        '2222',
        '--',
        'me@box.example.com',
      ])
      expect(shellQuote(`it's`)).toBe(`'it'\\''s'`)
      expect(sshArgs('ssh://', [])).toBeUndefined()
    })

    it('hands the box every argument as it is, and its exit code and output, stdout and stderr apart', async () => {
      await box()
      const pwned = join(await mkdtemp(join(tmpdir(), 'awaywork-pwned-')), 'pwned')
      const { url, log } = await serve(
        'console.log(JSON.stringify(process.argv.slice(1))); console.error("err"); process.exit(3)',
      )
      vi.stubEnv('BOX_URL', url)
      const nasty = [
        `it's`,
        'a  b',
        '"double"',
        `; touch ${pwned}`,
        `$(touch ${pwned})`,
        `\`touch ${pwned}\``,
        `| touch ${pwned} &`,
        'line\nbreak',
        '\\',
        '*',
        '~',
        '#',
        '',
      ]
      const calls = [
        ['approve', 'chores:CH-1', ...nasty],
        ['skip', 'x', `--reason=-${nasty.join('')}`],
      ]
      const out = output()
      for (const args of calls) expect(await remoteCall(args, { url: 'ssh://box' })).toBe(3)
      expect(out).toEqual({
        stdout: calls
          .map((args) => `${JSON.stringify(['--config', '/daemon/config.yml', ...args])}\n`)
          .join(''),
        stderr: 'err\nerr\n',
      })
      expect(existsSync(pwned)).toBe(false)
      expect(log).toEqual(calls.map((args) => `remote: ${JSON.stringify(args)}: exit 3`))
    }, 20_000)

    it("fails in one line naming AWAYWORK_REMOTE when ssh can't connect, awaywork isn't on the box's PATH or its daemon isn't serving", async () => {
      await box()
      vi.stubEnv('BOX_URL', await free())
      const out = output()
      expect(await remoteCall(['plan'], { url: 'ssh://down' })).toBe(1)
      expect(await remoteCall(['plan'], { url: 'ssh://box' })).toBe(1)
      vi.stubEnv('BOX_PATH', '/usr/bin:/bin')
      expect(await remoteCall(['plan'], { url: 'ssh://box' })).toBe(1)
      expect(out.stderr.split('\n')).toEqual([
        "can't reach AWAYWORK_REMOTE (ssh://down): ssh: connect to host down port 22: Connection refused",
        expect.stringMatching(
          /^AWAYWORK_REMOTE \(ssh:\/\/box\): the box's daemon isn't serving \(connect ECONNREFUSED 127\.0\.0\.1:\d+\); is awaywork watch running there, with AWAYWORK_REMOTE_TOKEN in its env file\?$/,
        ),
        "AWAYWORK_REMOTE (ssh://box): awaywork isn't on the box's PATH for non-interactive ssh; install it and node system-wide there, or link both into /usr/local/bin",
        '',
      ])
    }, 20_000)

    it("says the box's daemon isn't serving when its env file has no token", async () => {
      const dir = await box('')
      const out = output()
      expect(await remoteCall(['plan'], { url: 'ssh://box' })).toBe(1)
      expect(out.stderr).toBe(
        `AWAYWORK_REMOTE (ssh://box): the box's daemon isn't serving, the box's ${join(dir, 'box-home', '.config', 'awaywork', 'env')} has no AWAYWORK_REMOTE_TOKEN; add one there and restart awaywork watch\n`,
      )
    }, 20_000)

    it("stops the box's command when the laptop's awaywork goes, with no terminal to pass a Ctrl-C", async () => {
      const dir = await box()
      const pid = join(dir, 'pid')
      const { url, log } = await serve(
        `require('node:fs').writeFileSync(${JSON.stringify(pid)}, String(process.pid)); setTimeout(() => {}, 30000)`,
      )
      vi.stubEnv('BOX_URL', url)
      const laptop = execa(
        process.execPath,
        [
          '--experimental-transform-types',
          '--disable-warning=ExperimentalWarning',
          '--import',
          './scripts/ts-resolve.mjs',
          'src/cli/index.ts',
          'stats',
        ],
        { cwd: root, env: { HOME: dir, AWAYWORK_REMOTE: 'ssh://box' }, reject: false },
      )
      await vi.waitFor(() => expect(existsSync(pid)).toBe(true), { timeout: 10_000 })
      laptop.kill('SIGKILL')
      const running = Number(await readFile(pid, 'utf8'))
      await vi.waitFor(() => expect(() => process.kill(running, 0)).toThrow())
      await vi.waitFor(() => expect(log).toEqual(['remote: ["stats"]: stopped, the client left']))
    }, 20_000)
  })
})
