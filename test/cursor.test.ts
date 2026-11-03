import { readFileSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it, vi } from 'vitest'
import type { Job, WorkerEvent } from '../src/core/types.js'
import { cliConfig, cursorProvider, mcpConfig, toEvents } from '../src/providers/cursor.js'
import { providerContract } from './contracts/provider.contract.js'
import { fakeItem } from './fakes/items.js'

const bin = fileURLToPath(new URL('./fakes/cursor.mjs', import.meta.url))
const provider = cursorProvider(bin)
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

providerContract(provider, job, ['package'])

async function collect(events: AsyncIterable<WorkerEvent>): Promise<WorkerEvent[]> {
  const all: WorkerEvent[] = []
  for await (const e of events) all.push(e)
  return all
}

const run = (j: Job) => collect(provider.run(j, new AbortController().signal))

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
      prompt: 'fix it',
    })
    expect(env.CURSOR_CONFIG_DIR).toBeUndefined()
    expect(env.XDG_CONFIG_HOME).toBeUndefined()
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
    await provider.prepare?.({ ...job(), dir, mcp })
    const read = async (name: string) => JSON.parse(await readFile(join(home, name), 'utf8'))
    expect(await read('cli-config.json')).toEqual({
      version: 1,
      permissions: {
        allow: ['Shell(*)', 'Read(**)', 'Write(**)', 'Mcp(db:*)', 'Mcp(sentry:search_issues)'],
        deny: [],
      },
    })
    expect(await read('mcp.json')).toEqual({
      mcpServers: {
        db: {
          command: 'npx',
          args: ['db-mcp'],
          env: { READ_ONLY: '1', DB_URL: '${env:DB_URL}' },
          startupTimeoutSec: 60,
        },
        sentry: {
          url: 'https://mcp.sentry.dev/mcp',
          headers: { Authorization: 'Bearer ${env:SENTRY_TOKEN}', 'X-Org': 'acme' },
        },
      },
    })
    await expect(readFile(join(home, 'hooks.json'))).rejects.toThrow()
    expect(cliConfig({}).permissions.allow).toEqual(['Shell(*)', 'Read(**)', 'Write(**)'])
    expect(mcpConfig({})).toEqual({ mcpServers: {} })
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

  it('reads the version, probes nothing and is unavailable on a GitHub-hosted runner only', async () => {
    expect(await provider.detect()).toEqual({ installed: true, version: '2026.10.22-27dcf5f' })
    expect(await cursorProvider('/nonexistent/agent').detect()).toEqual({ installed: false })
    expect(await provider.probe({ env: {}, log: () => {} })).toBeNull()
    expect(provider.unavailable?.({ RUNNER_ENVIRONMENT: 'github-hosted' })).toMatch(/self-hosted/)
    expect(provider.unavailable?.({ RUNNER_ENVIRONMENT: 'self-hosted' })).toBeUndefined()
    expect(provider.unavailable?.({})).toBeUndefined()
  })
})
