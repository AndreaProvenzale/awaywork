import { readFileSync } from 'node:fs'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execa } from 'execa'
import { describe, expect, it, vi } from 'vitest'
import type { Job, WorkerEvent } from '../src/core/types.js'
import { codexProvider, lock, mcpOverrides, toEvents, toQuota } from '../src/providers/codex.js'
import { providerContract } from './contracts/provider.contract.js'
import { fakeItem } from './fakes/items.js'

const bin = fileURLToPath(new URL('./fakes/codex.mjs', import.meta.url))
const tmp = await mkdtemp(join(tmpdir(), 'awaywork-codex-'))
const lockFile = join(tmp, 'codex.lock')
const provider = codexProvider(bin, lockFile)
const recorded = (name: string) =>
  readFileSync(new URL(`./fixtures/codex/${name}.jsonl`, import.meta.url), 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line))

const job = (maxTurns = 10): Job => ({
  unit: {
    id: 'fake-1',
    items: [fakeItem()],
    repo: 'acme/api',
    base: '',
    foreign: false,
    network: true,
    untrusted: false,
    branch: 'away/fake-1',
    rule: { skill: 'fix-ci', provider: [], skills: [], instructions: [] },
    skill: 'fix-ci',
    skills: [],
    providers: ['codex'],
    instructions: [],
    deliver: 'draft_pr',
  },
  dir: tmp,
  prompt: 'fix it',
  maxTurns,
  env: process.env,
})

providerContract(provider, job)

async function collect(events: AsyncIterable<WorkerEvent>): Promise<WorkerEvent[]> {
  const all: WorkerEvent[] = []
  for await (const e of events) all.push(e)
  return all
}

const monthly = {
  windows: [{ name: '30d', span: 'long', used: 0.04, resetsAt: 1793021152 }],
}

describe('codex provider', () => {
  it('turns a recorded run into tool logs and a done event', () => {
    expect(recorded('exec').flatMap(toEvents)).toEqual([
      {
        type: 'log',
        line: `command: /bin/zsh -lc "sed -n '1,160p' hello.txt && git status --short" (exit 0)`,
      },
      { type: 'log', line: 'edit: /work/hello.txt' },
      {
        type: 'log',
        line: `command: /bin/zsh -lc "git add hello.txt && git commit -m 'fix typos'" (exit 0)`,
      },
      { type: 'log', line: 'result: completed' },
      { type: 'done', ok: true, turns: 0 },
    ])
    expect(recorded('failed').flatMap(toEvents).at(-1)).toEqual({
      type: 'done',
      ok: false,
      turns: 0,
    })
  })

  it('reads windows from the rate-limit snapshot, by their length', () => {
    const [, , limits] = recorded('rate-limits')
    expect(toQuota(limits.result.rateLimits)).toEqual(monthly)
    const plus = {
      primary: { usedPercent: 12, windowDurationMins: 300, resetsAt: 100 },
      secondary: { usedPercent: 40, windowDurationMins: 10080, resetsAt: 200 },
    }
    expect(toQuota(plus)?.windows).toEqual([
      { name: '5h', span: 'short', used: 0.12, resetsAt: 100 },
      { name: '7d', span: 'long', used: 0.4, resetsAt: 200 },
    ])
    expect(toQuota({ primary: null, secondary: null })).toBeNull()
  })

  it('reads the version and probes through the app server', async () => {
    expect(await provider.detect()).toEqual({ installed: true, version: '0.149.1' })
    expect(await codexProvider('/nonexistent/codex').detect()).toEqual({ installed: false })
    expect(await provider.probe({ env: process.env, log: () => {} })).toEqual(monthly)
    const lines: string[] = []
    const missing = codexProvider('/nonexistent/codex', lockFile)
    expect(await missing.probe({ env: process.env, log: (l) => lines.push(l) })).toBeNull()
    expect(lines[0]).toMatch(/^codex probe: /)
  })

  it('counts tool calls as turns and reports quota after the run', async () => {
    const events = await collect(provider.run(job(), new AbortController().signal))
    expect(events.filter((e) => e.type === 'quota')).toEqual([{ type: 'quota', quota: monthly }])
    expect(events.at(-1)).toEqual({ type: 'done', ok: true, turns: 3 })
  })

  it('kills the binary past the turn cap', async () => {
    const events = await collect(provider.run(job(1), new AbortController().signal))
    expect(events.slice(-3)).toEqual([
      { type: 'log', line: 'result: max_turns (1)' },
      { type: 'quota', quota: monthly },
      { type: 'done', ok: false, turns: 2 },
    ])
  })

  it('passes the model only when one is set', async () => {
    process.env.FAKE_ARGV = join(tmp, 'argv.json')
    const argv = async (model?: string) => {
      await collect(provider.run({ ...job(), model }, new AbortController().signal))
      return JSON.parse(await readFile(join(tmp, 'argv.json'), 'utf8')) as string[]
    }
    try {
      expect((await argv('gpt-5-codex')).join(' ')).toContain('-m gpt-5-codex')
      expect(await argv()).not.toContain('-m')
    } finally {
      delete process.env.FAKE_ARGV
    }
  })

  it('drops full access for a profile without network when the unit is offline', async () => {
    process.env.FAKE_ARGV = join(tmp, 'argv.json')
    const argv = async (network: boolean) => {
      const unit = { ...job().unit, network }
      const config = {
        config: {
          web_search: 'live',
          default_permissions: 'open',
          sandbox_mode: 'danger-full-access',
        },
      }
      await collect(provider.run({ ...job(), unit, config }, new AbortController().signal))
      return JSON.parse(await readFile(join(tmp, 'argv.json'), 'utf8')) as string[]
    }
    try {
      expect((await argv(true)).join(' ')).toContain('--sandbox danger-full-access')
      const offline = await argv(false)
      expect(offline).not.toContain('--sandbox')
      expect(offline).toContain('permissions.awaywork.network.enabled=false')
      expect(offline.findLast((a) => a.startsWith('web_search='))).toBe('web_search="disabled"')
      expect(offline.findLast((a) => a.startsWith('default_permissions='))).toBe(
        'default_permissions="awaywork"',
      )
      expect(offline.join(' ')).toContain(`${JSON.stringify(join(tmp, '.git'))}="write"`)
    } finally {
      delete process.env.FAKE_ARGV
    }
  })

  it('passes each config value as -c', async () => {
    process.env.FAKE_ARGV = join(tmp, 'argv.json')
    try {
      const config = { config: { model_reasoning_effort: 'high', 'tools.web_search': false } }
      await collect(provider.run({ ...job(), config }, new AbortController().signal))
      const args = JSON.parse(await readFile(join(tmp, 'argv.json'), 'utf8')) as string[]
      expect(args.join(' ')).toContain('-c model_reasoning_effort="high" -c tools.web_search=false')
    } finally {
      delete process.env.FAKE_ARGV
    }
  })

  it('passes MCP servers as -c, their secrets forwarded by name and kept out of the shell', () => {
    const flags = mcpOverrides({
      db: {
        command: 'npx',
        args: ['db-mcp'],
        env: { READ_ONLY: '1' },
        secrets: ['DATABASE_URL'],
        tools: ['query'],
      },
      sentry: {
        url: 'https://mcp.sentry.dev/mcp',
        headers: { Authorization: 'Bearer ${SENTRY_TOKEN}', 'X-Org': 'acme', 'X-Key': '${KEY}' },
        secrets: ['SENTRY_TOKEN', 'KEY'],
      },
    })
    expect(flags.filter((f) => f !== '-c')).toEqual([
      'mcp_servers.db.command="npx"',
      'mcp_servers.db.args=["db-mcp"]',
      'mcp_servers.db.env={"READ_ONLY"="1"}',
      'mcp_servers.db.env_vars=["DATABASE_URL"]',
      'mcp_servers.db.enabled_tools=["query"]',
      'mcp_servers.db.startup_timeout_sec=60',
      'mcp_servers.db.default_tools_approval_mode="approve"',
      'mcp_servers.sentry.url="https://mcp.sentry.dev/mcp"',
      'mcp_servers.sentry.bearer_token_env_var="SENTRY_TOKEN"',
      'mcp_servers.sentry.http_headers={"X-Org"="acme"}',
      'mcp_servers.sentry.env_http_headers={"X-Key"="KEY"}',
      'mcp_servers.sentry.startup_timeout_sec=60',
      'mcp_servers.sentry.default_tools_approval_mode="approve"',
      'shell_environment_policy.exclude=["DATABASE_URL","SENTRY_TOKEN","KEY"]',
    ])
    expect(mcpOverrides({})).toEqual([])
  })

  it('logs an MCP call with its server and arguments', () => {
    const item = { type: 'mcp_tool_call', server: 'db', tool: 'query', arguments: { sql: 'x' } }
    expect(toEvents({ type: 'item.completed', item })).toEqual([
      { type: 'log', line: 'mcp_tool_call: db/query: {"sql":"x"}' },
    ])
  })

  it('fails a turn the model could not finish', async () => {
    process.env.FAKE_CODEX_RUN = 'failed'
    try {
      const events = await collect(provider.run(job(), new AbortController().signal))
      expect(events.at(-1)).toEqual({ type: 'done', ok: false, turns: 0 })
    } finally {
      delete process.env.FAKE_CODEX_RUN
    }
  })

  it('kills the binary when aborted mid-run', async () => {
    process.env.FAKE_CODEX_HANG = '1'
    const abort = new AbortController()
    const events: WorkerEvent[] = []
    try {
      for await (const e of provider.run(job(), abort.signal)) {
        events.push(e)
        abort.abort()
      }
    } finally {
      delete process.env.FAKE_CODEX_HANG
    }
    expect(events.at(-1)).toEqual({ type: 'done', ok: false, turns: 1 })
  })

  it('kills what the binary left running once it exits', async () => {
    const root = await mkdtemp(join(tmpdir(), 'awaywork-left-'))
    const pid = join(root, 'left.pid')
    const script = join(root, 'leaves.sh')
    // The quota probe after the run calls it again, as `app-server`.
    const leaves = `[ "$1" = app-server ] || { /bin/sleep 30 >/dev/null 2>&1 & echo $! > ${pid}; }`
    await writeFile(script, `#!/bin/sh\n${leaves}\n`, { mode: 0o755 })
    await collect(codexProvider(script, lockFile).run(job(), new AbortController().signal))
    const left = Number(await readFile(pid, 'utf8'))
    await vi.waitFor(() => expect(() => process.kill(left, 0)).toThrow(), { timeout: 2000 })
  })

  it('is unavailable on a GitHub-hosted runner only', () => {
    expect(provider.unavailable?.({ RUNNER_ENVIRONMENT: 'github-hosted' })).toMatch(/self-hosted/)
    expect(provider.unavailable?.({ RUNNER_ENVIRONMENT: 'self-hosted' })).toBeUndefined()
    expect(provider.unavailable?.({})).toBeUndefined()
  })

  it('serializes on a lock held by a live process and takes over a dead one', async () => {
    const file = join(tmp, 'other.lock')
    const dead = await execa('node', ['-e', 'console.log(process.pid)'])
    await writeFile(file, dead.stdout)
    const release = await lock(file, () => {})
    expect(await readFile(file, 'utf8')).toBe(String(process.pid))

    const waits: string[] = []
    let second = false
    const next = lock(file, (line) => waits.push(line)).then((r) => {
      second = true
      return r
    })
    await new Promise((r) => setTimeout(r, 200))
    expect(second).toBe(false)
    expect(waits).toEqual([`codex: waiting for pid ${process.pid}, which holds ${file}`])
    await release()
    await (await next)()
  })
})
