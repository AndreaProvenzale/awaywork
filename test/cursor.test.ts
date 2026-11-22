import { readFileSync } from 'node:fs'
import {
  appendFile,
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execa } from 'execa'
import { describe, expect, it, vi } from 'vitest'
import type { Job, WorkerEvent } from '#core/types'
import { cliConfig, cursorProvider, mcpConfig, refusedLines, toEvents } from '#providers/cursor'
import { providerContract } from './contracts/provider.contract'
import { fakeItem } from './fakes/items'

const bin = fileURLToPath(new URL('./fakes/cursor.mjs', import.meta.url))
const provider = cursorProvider(bin, async () => true)
const unwalled = cursorProvider(bin, async () => false)
const tmp = await mkdtemp(join(tmpdir(), 'awaywork-cursor-'))
const recorded = (name: string) =>
  readFileSync(new URL(`./fixtures/cursor/${name}.jsonl`, import.meta.url), 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line))

const job = (env: NodeJS.ProcessEnv = {}, maxTurns = 10): Job => ({
  unit: {
    id: 'fake-1',
    items: [fakeItem()],
    repo: 'acme/api',
    base: '',
    foreign: false,
    untrusted: false,
    branch: 'away/fake-1',
    rule: { skill: 'fix', provider: [], skills: [], instructions: [] },
    skill: 'fix',
    skills: [],
    providers: ['cursor'],
    instructions: [],
    deliver: 'draft_pr',
  },
  dir: tmp,
  prompt: 'fix it',
  maxTurns,
  env: { ...process.env, ...env },
})

providerContract(provider, job)

async function collect(events: AsyncIterable<WorkerEvent>): Promise<WorkerEvent[]> {
  const all: WorkerEvent[] = []
  for await (const e of events) all.push(e)
  return all
}

const run = async (j: Job) => {
  await provider.prepare?.(j)
  return collect(provider.run(j, new AbortController().signal))
}

describe('cursor provider', () => {
  it('logs each tool call once it completes, and the result', () => {
    expect(recorded('exec').flatMap(toEvents)).toEqual([
      { type: 'log', line: 'read: /work/repo1/notes.txt' },
      { type: 'log', line: 'command: ls -la /work/repo1 (exit 0)' },
      { type: 'log', line: 'grep: hello' },
      { type: 'log', line: 'edit: /work/repo1/notes.txt' },
      { type: 'log', line: 'result: success' },
    ])
    expect(recorded('denied').flatMap(toEvents)).toEqual([
      { type: 'log', line: 'mcp_tool_call: awayEcho/shout: {"text":"hi"} (permissionDenied)' },
      { type: 'log', line: 'mcp_tool_call: awayEcho/echo: {"text":"yo"}' },
      { type: 'log', line: 'result: success' },
    ])
    const completed = (call: object) => ({
      type: 'tool_call',
      subtype: 'completed',
      tool_call: call,
    })
    expect(
      [
        {
          taskToolCall: {
            args: { description: 'Run three echo commands' },
            result: { success: {} },
          },
        },
        { deleteToolCall: { args: { path: 'a.txt' }, result: { success: {} } } },
      ].flatMap((call) => toEvents(completed(call))),
    ).toEqual([
      { type: 'log', line: 'task: Run three echo commands' },
      { type: 'log', line: 'deleteToolCall: {"path":"a.txt"}' },
    ])
    const sandboxed = recorded('sandboxed').flatMap(toEvents)
    expect(sandboxed.slice(0, 2)).toEqual([
      { type: 'log', line: expect.stringMatching(/^command: curl .* \(rejected\)$/) },
      { type: 'log', line: expect.stringMatching(/^command: touch .* \(rejected\)$/) },
    ])
  })

  it('counts completed tool calls as turns, not MCP tool discovery', async () => {
    expect((await run(job())).at(-1)).toEqual({ type: 'done', ok: true, turns: 4 })
    const mcp = await run(job({ FAKE_CURSOR_RUN: 'mcp' }))
    expect(mcp.at(-1)).toEqual({ type: 'done', ok: true, turns: 1 })
  })

  it('kills the binary past the turn cap', async () => {
    const events = await run(job({}, 1))
    expect(events.slice(-2)).toEqual([
      { type: 'log', line: 'result: max_turns (1)' },
      { type: 'done', ok: false, turns: 2 },
    ])
  })

  it('fails a run with no result, and says why the binary exited', async () => {
    expect((await run(job({ FAKE_CURSOR_RUN: 'killed' }))).at(-1)).toEqual({
      type: 'done',
      ok: false,
      turns: 3,
    })
    expect(await run(job({ FAKE_CURSOR_RUN: 'bad-key' }))).toEqual([
      { type: 'log', line: 'error: Error: The provided API key is invalid.' },
      { type: 'done', ok: false, turns: 0 },
    ])
  })

  it('kills the binary when aborted mid-run', async () => {
    const abort = new AbortController()
    const events: WorkerEvent[] = []
    await provider.prepare?.(job())
    for await (const e of provider.run(job({ FAKE_CURSOR_HANG: '1' }), abort.signal)) {
      events.push(e)
      abort.abort()
    }
    expect(events.at(-1)).toEqual({ type: 'done', ok: false, turns: 1 })
  })

  it('kills the worker-server it leaves running', async () => {
    const pid = join(tmp, 'left.pid')
    await run(job({ FAKE_LEFT: pid }))
    const left = Number(await readFile(pid, 'utf8'))
    await vi.waitFor(() => expect(() => process.kill(left, 0)).toThrow(), { timeout: 2000 })
  })

  it('ends the run soon after its result, with what the binary left running', async () => {
    const pid = join(tmp, 'waited.pid')
    const script = join(tmp, 'waits.sh')
    const fixture = fileURLToPath(new URL('./fixtures/cursor/exec.jsonl', import.meta.url))
    const waits = `cat ${fixture}; echo warning >&2; /bin/sleep 30 >/dev/null 2>&1 & echo $! > ${pid}; wait`
    await writeFile(script, `#!/bin/sh\n${waits}\n`, { mode: 0o755 })
    const started = Date.now()
    const events = await collect(cursorProvider(script).run(job(), new AbortController().signal))
    expect(Date.now() - started).toBeLessThan(8000)
    expect(events).not.toContainEqual(
      expect.objectContaining({ type: 'log', line: expect.stringMatching(/^error:/) }),
    )
    expect(events.at(-1)).toEqual({ type: 'done', ok: true, turns: 4 })
    const left = Number(await readFile(pid, 'utf8'))
    await vi.waitFor(() => expect(() => process.kill(left, 0)).toThrow(), { timeout: 2000 })
  })

  it('runs in print mode on the prompt, never forcing or approving MCP servers', async () => {
    const file = join(tmp, 'argv.json')
    const argv = async (more: Partial<Job>) => {
      await run({ ...job({ FAKE_ARGV: file }), ...more })
      return JSON.parse(await readFile(file, 'utf8')) as string[]
    }
    expect(await argv({})).toEqual(['-p', '--output-format', 'stream-json', '--trust'])
    expect(await argv({ model: 'composer-2.5', plugin: '/plugins/u1' })).toEqual([
      ...['-p', '--output-format', 'stream-json', '--trust'],
      ...['--model', 'composer-2.5', '--plugin-dir', '/plugins/u1'],
    ])
  })

  it('runs in a HOME of its own, off the Keychain and your Cursor config', async () => {
    const file = join(tmp, 'env.json')
    const yours = { CURSOR_CONFIG_DIR: '/Users/dev/.cursor', XDG_CONFIG_HOME: '/Users/dev/.config' }
    await run(job({ FAKE_ENV: file, CURSOR_API_KEY: 'key', HOME: '/Users/dev', ...yours }))
    const env = JSON.parse(await readFile(file, 'utf8'))
    expect(env).toMatchObject({
      HOME: join(tmp, '.away/agent-home'),
      AGENT_CLI_CREDENTIAL_STORE: 'memory',
      CURSOR_API_KEY: 'key',
      prompt: expect.stringMatching(/^fix it\n/),
    })
    expect(env.CURSOR_CONFIG_DIR).toBeUndefined()
    expect(env.XDG_CONFIG_HOME).toBeUndefined()
  })

  it("keeps the MCP servers' secrets out of the shell's env", async () => {
    const file = join(tmp, 'env-mcp.json')
    const mcp = { db: { command: 'npx', secrets: ['DB_URL', 'CURSOR_API_KEY'] } }
    await run({ ...job({ FAKE_ENV: file, DB_URL: 'pg://x', CURSOR_API_KEY: 'key' }), mcp })
    const env = JSON.parse(await readFile(file, 'utf8'))
    expect(env.DB_URL).toBeUndefined()
    expect(env.CURSOR_API_KEY).toBe('key')
  })

  it("writes the run's HOME afresh: its permissions and MCP servers", async () => {
    const dir = await mkdtemp(join(tmpdir(), 'awaywork-agent-home-'))
    const home = join(dir, '.away/agent-home/.cursor')
    await mkdir(home, { recursive: true })
    await writeFile(join(home, 'hooks.json'), '{}')
    const mcp = {
      db: { command: 'npx', args: ['db-mcp'], env: { READ_ONLY: '1' }, secrets: ['DB_URL'] },
      sentry: {
        url: 'https://mcp.sentry.dev/mcp',
        headers: { Authorization: 'Bearer ${SENTRY_TOKEN}', 'X-Org': 'acme' },
        secrets: ['SENTRY_TOKEN'],
        tools: ['search_issues'],
      },
    }
    await provider.prepare?.({ ...job({ DB_URL: 'pg://x', SENTRY_TOKEN: 'tok' }), dir, mcp })
    const read = async (name: string) => JSON.parse(await readFile(join(home, name), 'utf8'))
    expect(await read('cli-config.json')).toEqual({
      version: 1,
      sandbox: { mode: 'enabled', networkAccess: 'user_config_only' },
      permissions: {
        allow: ['Read(**)', 'Write(**)', 'Mcp(db:*)', 'Mcp(sentry:search_issues)'],
        deny: ['Write(**/.cursor/**)', 'Write(**/.claude/**)'],
      },
    })
    expect(await read('sandbox.json')).toEqual({
      networkPolicy: {
        default: 'deny',
        allow: ['localhost', '127.0.0.1'],
        logging: { decisionLogPath: join(dir, '.away/cursor-network.jsonl'), logFormat: 'jsonl' },
      },
    })
    expect(await read('mcp.json')).toEqual({
      mcpServers: {
        db: {
          command: 'npx',
          args: ['db-mcp'],
          env: { READ_ONLY: '1', DB_URL: 'pg://x' },
          startupTimeoutSec: 60,
        },
        sentry: {
          url: 'https://mcp.sentry.dev/mcp',
          headers: { Authorization: 'Bearer tok', 'X-Org': 'acme' },
        },
      },
    })
    expect((await stat(join(home, 'mcp.json'))).mode & 0o777).toBe(0o600)
    await expect(readFile(join(home, 'hooks.json'))).rejects.toThrow()
    expect(cliConfig({}).permissions.allow).toEqual(['Shell(*)', 'Read(**)', 'Write(**)'])
    expect(cliConfig({}, ['*']).sandbox).toEqual({ mode: 'enabled', networkAccess: 'allow_all' })
    expect(mcpConfig({}, {})).toEqual({ mcpServers: {} })
  })

  it('empties an agent home holding a read-only folder', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'awaywork-cursor-ro-'))
    const cache = join(dir, '.away/agent-home/go/pkg')
    await mkdir(cache, { recursive: true })
    await writeFile(join(cache, 'mod.go'), 'x')
    await chmod(cache, 0o555)
    await provider.prepare?.({ ...job(), dir })
    expect(await readdir(join(dir, '.away/agent-home'))).toEqual(['.cursor'])
  })

  it('unlinks a linked agent home without touching its target', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'awaywork-cursor-home-link-'))
    const outside = await mkdtemp(join(tmpdir(), 'awaywork-outside-'))
    const sub = join(outside, 'sub')
    await mkdir(sub)
    await writeFile(join(sub, 'f'), 'x')
    await chmod(join(sub, 'f'), 0o444)
    await chmod(sub, 0o555)
    await mkdir(join(dir, '.away'))
    await symlink(outside, join(dir, '.away/agent-home'))
    await provider.prepare?.({ ...job(), dir })
    expect((await stat(sub)).mode & 0o777).toBe(0o555)
    expect((await stat(join(sub, 'f'))).mode & 0o777).toBe(0o444)
    expect((await lstat(join(dir, '.away/agent-home'))).isSymbolicLink()).toBe(false)
  })

  it('refuses a linked .away', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'awaywork-cursor-link-'))
    const outside = await mkdtemp(join(tmpdir(), 'awaywork-outside-'))
    await mkdir(join(outside, 'agent-home'))
    await writeFile(join(outside, 'agent-home/keep.txt'), 'KEEP')
    await symlink(outside, join(dir, '.away'))
    await expect(provider.prepare?.({ ...job(), dir })).rejects.toThrow('.away in the clone')
    expect(await readFile(join(outside, 'agent-home/keep.txt'), 'utf8')).toBe('KEEP')
  })

  it('reads the version, probes nothing and installs by script on a GitHub-hosted runner', async () => {
    expect(await provider.detect()).toEqual({ installed: true, version: '2026.10.22-27dcf5f' })
    expect(await cursorProvider('/nonexistent/agent').detect()).toEqual({ installed: false })
    // Some other `agent` that answers --version.
    expect(await cursorProvider('/bin/echo').detect()).toEqual({ installed: false })
    expect(await provider.probe({ env: {}, log: () => {} })).toBeNull()
    expect(provider.unavailable).toBeUndefined()
    expect(provider.install).toEqual({
      script: expect.stringContaining('| HOME=/opt/cursor bash'),
    })
  })
})

describe('cursor shell walled to the network hosts', () => {
  const homeOf = (dir: string) => join(dir, '.away/agent-home/.cursor')
  const walled = async (unit: Partial<Job['unit']>, make = provider) => {
    const dir = await mkdtemp(join(tmpdir(), 'awaywork-cursor-wall-'))
    await make.prepare?.({ ...job(), unit: { ...job().unit, ...unit }, dir })
    const read = async (name: string) => JSON.parse(await readFile(join(homeOf(dir), name), 'utf8'))
    return { dir, read }
  }

  it("lists the unit's hosts in sandbox.json, and opens the shell for *", async () => {
    const hosts = await walled({ network: ['pypi.org', '*.prisma.sh'] })
    expect((await hosts.read('sandbox.json')).networkPolicy).toMatchObject({
      default: 'deny',
      allow: ['localhost', '127.0.0.1', 'pypi.org', '*.prisma.sh'],
    })
    expect((await hosts.read('cli-config.json')).sandbox.networkAccess).toBe('user_config_only')
    const all = await walled({ network: ['*'] })
    expect((await all.read('cli-config.json')).sandbox.networkAccess).toBe('allow_all')
  })

  it("lists the job's writable paths in sandbox.json", async () => {
    const dir = await mkdtemp(join(tmpdir(), 'awaywork-cursor-wall-'))
    await provider.prepare?.({ ...job(), dir, writable: ['/h/.npm'] })
    const file = join(homeOf(dir), 'sandbox.json')
    expect(JSON.parse(await readFile(file, 'utf8')).additionalReadwritePaths).toEqual(['/h/.npm'])
    const none = await walled({})
    expect(await none.read('sandbox.json')).not.toHaveProperty('additionalReadwritePaths')
  })

  it("lists no host on an untrusted author's PR", async () => {
    const { read } = await walled({ network: ['pypi.org'], untrusted: true })
    expect((await read('sandbox.json')).networkPolicy.allow).toEqual(['localhost', '127.0.0.1'])
  })

  it("lists no host on a stranger's issue", async () => {
    const { read } = await walled({ network: ['pypi.org'], untrustedText: true })
    expect((await read('sandbox.json')).networkPolicy.allow).toEqual(['localhost', '127.0.0.1'])
  })

  it("lists the hosts on a trusted author's PR", async () => {
    const { read } = await walled({ network: ['pypi.org'], foreign: true })
    expect((await read('sandbox.json')).networkPolicy.allow).toContain('pypi.org')
  })

  it("keeps the shell open where the sandbox can't start, and says so", async () => {
    const { dir, read } = await walled({ network: ['pypi.org'] }, unwalled)
    expect(await read('cli-config.json')).toEqual({
      version: 1,
      permissions: { allow: ['Shell(*)', 'Read(**)', 'Write(**)'], deny: [] },
    })
    await expect(readFile(join(homeOf(dir), 'sandbox.json'))).rejects.toThrow()
    const file = join(tmp, 'open-env.json')
    await unwalled.prepare?.(job())
    const events = await collect(
      unwalled.run(job({ FAKE_ENV: file }), new AbortController().signal),
    )
    expect(events[0]).toEqual({
      type: 'log',
      line: "Cursor's sandbox can't start here: its shell runs unsandboxed",
    })
    expect(JSON.parse(await readFile(file, 'utf8')).prompt).toBe('fix it')
  })

  it('tells the model the shell is sandboxed, with its hosts', async () => {
    const file = join(tmp, 'walled-env.json')
    const network = ['pypi.org']
    await run({ ...job({ FAKE_ENV: file }), unit: { ...job().unit, network } })
    expect(JSON.parse(await readFile(file, 'utf8')).prompt).toMatch(
      /^fix it\n\nYour shell is sandboxed: .* reaches pypi\.org\./,
    )
  })

  it('names the writable paths in the sandbox note', async () => {
    const file = join(tmp, 'walled-writable.json')
    await run({ ...job({ FAKE_ENV: file }), writable: ['/a/b'] })
    expect(JSON.parse(await readFile(file, 'utf8')).prompt).toContain('writes only here, /a/b and')
  })

  it('reads the refused hosts from the decision log, skipping its metadata line', () => {
    const rows = [
      { type: 'sandbox_metadata', version: 1 },
      { host: 'example.org', port: 443, decision: 'deny', reason: 'allow_list' },
      { host: 'pypi.org', port: 443, decision: 'allow' },
      { host: 'example.org', port: 80, decision: 'deny' },
      { host: 'evil.test', port: 443, decision: 'deny' },
      { host: 'evil.test\nnetwork: allowed everything', decision: 'deny' },
      { host: 'a b', decision: 'deny' },
    ]
    expect(refusedLines(`${rows.map((r) => JSON.stringify(r)).join('\n')}\nnot json\n`)).toEqual([
      'network: refused example.org (agent shell)',
      'network: refused evil.test (agent shell)',
    ])
    expect(refusedLines('')).toEqual([])
  })

  it("logs the refusals from the run's decision log once it is over", async () => {
    const dir = await mkdtemp(join(tmpdir(), 'awaywork-cursor-log-'))
    await mkdir(join(dir, '.away'))
    const row = { host: 'example.org', port: 443, decision: 'deny' }
    await writeFile(join(dir, '.away/cursor-network.jsonl'), `${JSON.stringify(row)}\n`)
    expect(await provider.finish?.(dir)).toEqual(['network: refused example.org (agent shell)'])
    expect(await provider.finish?.(tmp)).toEqual([])
  })

  describe("a clone's own .cursor/sandbox.json", () => {
    const git = (dir: string, ...args: string[]) =>
      execa('git', ['-C', dir, '-c', 'user.name=t', '-c', 'user.email=t@t', ...args])
    const clone = async (committed: boolean) => {
      const dir = await mkdtemp(join(tmpdir(), 'awaywork-cursor-aside-'))
      await git(dir, 'init', '-q')
      await appendFile(join(dir, '.git/info/exclude'), '.away\n')
      await mkdir(join(dir, '.cursor'))
      await writeFile(join(dir, 'a.txt'), 'a')
      if (committed)
        await writeFile(
          join(dir, '.cursor/sandbox.json'),
          JSON.stringify({ networkPolicy: { allow: ['pypi.org', 'files.pythonhosted.org'] } }),
        )
      await git(dir, 'add', '-A')
      await git(dir, 'commit', '-qm', 'init')
      return dir
    }
    const status = async (dir: string) => (await git(dir, 'status', '--porcelain')).stdout

    it('moves out for the run, stays out of its commits, and comes back with a clean tree', async () => {
      const dir = await clone(true)
      const j = { ...job(), dir }
      await provider.prepare?.(j)
      expect(await provider.setAside?.(j)).toEqual([
        'network: set aside .cursor/sandbox.json (adds pypi.org, files.pythonhosted.org)',
      ])
      await expect(stat(join(dir, '.cursor/sandbox.json'))).rejects.toThrow()
      expect(await status(dir)).toBe('')
      await writeFile(join(dir, 'b.txt'), 'b')
      await git(dir, 'add', '-A')
      await git(dir, 'commit', '-qm', 'work')
      expect((await git(dir, 'show', '--name-status', '--format=', 'HEAD')).stdout).toBe('A\tb.txt')
      await provider.finish?.(dir)
      expect(await readFile(join(dir, '.cursor/sandbox.json'), 'utf8')).toContain('pypi.org')
      expect(await status(dir)).toBe('')
      expect((await git(dir, 'ls-files', '-v', '--', '.cursor')).stdout).toMatch(/^H /)
    })

    it('puts nothing back for a path the worker took out of the index', async () => {
      const dir = await clone(true)
      await provider.prepare?.({ ...job(), dir })
      await provider.setAside?.({ ...job(), dir })
      await git(dir, 'update-index', '--no-skip-worktree', '--', '.cursor/sandbox.json')
      await git(dir, 'commit', '-qam', 'del')
      await provider.finish?.(dir)
      await expect(stat(join(dir, '.cursor/sandbox.json'))).rejects.toThrow()
    })

    it('leaves a clone without one, and an unwalled run, alone', async () => {
      const bare = await clone(false)
      await provider.prepare?.({ ...job(), dir: bare })
      expect(await provider.setAside?.({ ...job(), dir: bare })).toEqual([])
      await provider.finish?.(bare)
      const open = await clone(true)
      await unwalled.prepare?.({ ...job(), dir: open })
      expect(await unwalled.setAside?.({ ...job(), dir: open })).toEqual([])
      await provider.finish?.(open)
      expect(await status(open)).toBe('')
      expect(await readFile(join(open, '.cursor/sandbox.json'), 'utf8')).toContain('pypi.org')
    })

    it('refuses one that links outside the clone', async () => {
      const dir = await clone(false)
      const outside = join(await mkdtemp(join(tmpdir(), 'awaywork-outside-')), 'sandbox.json')
      await writeFile(outside, '{}')
      await symlink(outside, join(dir, '.cursor/sandbox.json'))
      await provider.prepare?.({ ...job(), dir })
      await expect(provider.setAside?.({ ...job(), dir })).rejects.toThrow('links outside')
      expect(await readFile(outside, 'utf8')).toBe('{}')
    })

    it("is one of the files a PR author's clone hides from Cursor", () => {
      expect(provider.repoConfig).toContain('.cursor/sandbox.json')
    })
  })
})
