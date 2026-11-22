import { existsSync, readFileSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execa } from 'execa'
import { describe, expect, it, vi } from 'vitest'
import type { Job, WorkerEvent } from '#core/types'
import { codexProvider, mcpOverrides, shellWall, toEvents, toQuota } from '#providers/codex'
import { lock } from '#util/lock'
import { providerContract } from './contracts/provider.contract'
import { fakeItem } from './fakes/items'

const bin = fileURLToPath(new URL('./fakes/codex.mjs', import.meta.url))
const tmp = await mkdtemp(join(tmpdir(), 'awaywork-codex-'))
const lockFile = join(tmp, 'codex.lock')
const provider = codexProvider(bin, lockFile, undefined, async () => true)
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
    untrusted: false,
    branch: 'away/fake-1',
    rule: { skill: 'fix', provider: [], skills: [], instructions: [] },
    skill: 'fix',
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
  windows: [{ name: '30d', span: 'long', used: 0.04, resetsAt: 1793021152, minutes: 43200 }],
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
      { name: '5h', span: 'short', used: 0.12, resetsAt: 100, minutes: 300 },
      { name: '7d', span: 'long', used: 0.4, resetsAt: 200, minutes: 10080 },
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
      expect((await argv()).join(' ')).toContain('default_permissions="awaywork"')
      expect(await argv()).not.toContain('-m')
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

  it('turns off account apps, web search and rules, whatever the trust or the config', async () => {
    process.env.FAKE_ARGV = join(tmp, 'argv.json')
    try {
      for (const untrusted of [false, true]) {
        const run = job()
        run.unit.untrusted = untrusted
        const config = { config: { 'features.apps': true, web_search: 'live' } }
        await collect(provider.run({ ...run, config }, new AbortController().signal))
        const args = (JSON.parse(await readFile(join(tmp, 'argv.json'), 'utf8')) as string[]).join(
          ' ',
        )
        const last = (key: string) => args.lastIndexOf(`-c ${key}=`)
        expect(args).toContain('--ignore-user-config --ignore-rules')
        expect(args).toContain('-c features.apps=false -c web_search="disabled"')
        expect(last('features.apps')).toBeGreaterThan(args.indexOf('-c features.apps=true'))
        expect(last('web_search')).toBeGreaterThan(args.indexOf('-c web_search="live"'))
      }
    } finally {
      delete process.env.FAKE_ARGV
    }
  })

  const wall = (run: Job) => shellWall(run).filter((f) => f !== '-c')

  it("walls the shell to the clone and the unit's hosts, loopback open", () => {
    const run = job()
    run.unit.network = ['registry.npmjs.org', '*.prisma.sh']
    expect(wall(run)).toEqual([
      'default_permissions="awaywork"',
      `permissions.awaywork.filesystem={":root"="read",":tmpdir"="write","${tmp}"="write","${tmp}/.git"="write","${tmp}/.claude"="read","${tmp}/.mcp.json"="read"}`,
      'features.network_proxy=true',
      'permissions.awaywork.network.enabled=true',
      'permissions.awaywork.network.domains={"registry.npmjs.org"="allow","*.prisma.sh"="allow"}',
      'permissions.awaywork.network.allow_local_binding=true',
    ])
  })

  it("lets the shell write the job's writable paths", () => {
    const run = { ...job(), writable: ['/h/.npm', '/h/.cache/yarn'] }
    expect(wall(run)[1]).toContain('"/h/.npm"="write","/h/.cache/yarn"="write"')
    expect(wall(job())[1]).not.toContain('/h/')
  })

  it('is offline by default, and `*` passes through', () => {
    expect(wall(job())).toContain('permissions.awaywork.network.domains={}')
    const run = job()
    run.unit.network = ['*']
    expect(wall(run)).toContain('permissions.awaywork.network.domains={"*"="allow"}')
  })

  it("withholds the hosts from an untrusted author's PR", () => {
    const run = job()
    Object.assign(run.unit, { network: ['npmjs.org'], untrusted: true })
    expect(wall(run)).toContain('permissions.awaywork.network.domains={}')
  })

  it("withholds the hosts from a stranger's issue", () => {
    const run = job()
    Object.assign(run.unit, { network: ['npmjs.org'], untrustedText: true })
    expect(wall(run)).toContain('permissions.awaywork.network.domains={}')
  })

  it("gives a trusted author's PR the hosts", () => {
    const run = job()
    Object.assign(run.unit, { network: ['npmjs.org'], foreign: true, untrusted: false })
    expect(wall(run)).toContain('permissions.awaywork.network.domains={"npmjs.org"="allow"}')
  })

  it('keeps the shell open where the sandbox cannot start, and says so', async () => {
    process.env.FAKE_ARGV = join(tmp, 'argv.json')
    try {
      const open = codexProvider(bin, lockFile, undefined, async () => false)
      const events = await collect(open.run(job(), new AbortController().signal))
      const args = (JSON.parse(await readFile(join(tmp, 'argv.json'), 'utf8')) as string[]).join(
        ' ',
      )
      expect(args).toContain('--sandbox danger-full-access')
      expect(args).not.toContain('default_permissions')
      expect(events[0]).toEqual({
        type: 'log',
        line: "Codex's sandbox can't start here: its shell runs unsandboxed",
      })
    } finally {
      delete process.env.FAKE_ARGV
    }
  })

  it('logs a refusal Codex returns on stderr, when it rejects the command at spawn', async () => {
    process.env.FAKE_CODEX_STDERR =
      'ERROR codex_core::tools::router: error=exec_command failed: Rejected(\\"Network access to \\\\\\"httpbin.org\\\\\\" was blocked: domain is not on the allowlist\\")\\n'
    try {
      const events = await collect(provider.run(job(), new AbortController().signal))
      expect(events).toContainEqual({
        type: 'log',
        line: 'network: refused httpbin.org (agent shell)',
      })
    } finally {
      delete process.env.FAKE_CODEX_STDERR
    }
  })

  it('logs a host once across the stream and stderr', async () => {
    process.env.FAKE_CODEX_RUN = 'refused'
    process.env.FAKE_CODEX_STDERR =
      'Network access to "httpbin.org" was blocked\nNetwork access to "pypi.org" was blocked\n'
    try {
      const events = await collect(provider.run(job(), new AbortController().signal))
      const refused = events.flatMap((e) =>
        e.type === 'log' && e.line.startsWith('network:') ? [e.line] : [],
      )
      expect(refused).toEqual([
        'network: refused httpbin.org (agent shell)',
        'network: refused pypi.org (agent shell)',
      ])
    } finally {
      delete process.env.FAKE_CODEX_RUN
      delete process.env.FAKE_CODEX_STDERR
    }
  })

  it.runIf(process.platform === 'linux')(
    'has git ignore the masked .claude and .mcp.json from a file outside the clone, gone after the run',
    async () => {
      const dir = await mkdtemp(join(tmp, 'clone-'))
      process.env.FAKE_EXCLUDE = join(tmp, 'seen')
      try {
        await collect(provider.run({ ...job(), dir }, new AbortController().signal))
        const [file = '', ...lines] = (await readFile(join(tmp, 'seen'), 'utf8')).split('\n')
        expect(lines.join('\n')).toBe('/.claude\n/.mcp.json\n')
        expect(file.startsWith(dir)).toBe(false)
        expect(existsSync(file)).toBe(false)
      } finally {
        delete process.env.FAKE_EXCLUDE
      }
    },
  )

  it('logs the hosts the proxy refused, once each', () => {
    const blocked = (host: string) =>
      `curl: (56) CONNECT tunnel failed, response 403\nNetwork access to "${host}" was blocked: domain is not on the allowlist for the current sandbox mode.`
    const item = (output: string) => ({
      type: 'item.completed',
      item: {
        type: 'command_execution',
        command: 'curl x',
        exit_code: -1,
        aggregated_output: output,
      },
    })
    expect(toEvents(item(`${blocked('httpbin.org')}\n${blocked('httpbin.org')}`))).toEqual([
      { type: 'log', line: 'command: curl x (exit -1)' },
      { type: 'log', line: 'network: refused httpbin.org (agent shell)' },
    ])
    expect(toEvents(item('fine'))).toEqual([{ type: 'log', line: 'command: curl x (exit -1)' }])
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
      'mcp_servers.db.default_tools_approval_mode="approve"',
      'mcp_servers.db.startup_timeout_sec=60',
      'mcp_servers.sentry.url="https://mcp.sentry.dev/mcp"',
      'mcp_servers.sentry.bearer_token_env_var="SENTRY_TOKEN"',
      'mcp_servers.sentry.http_headers={"X-Org"="acme"}',
      'mcp_servers.sentry.env_http_headers={"X-Key"="KEY"}',
      'mcp_servers.sentry.default_tools_approval_mode="approve"',
      'mcp_servers.sentry.startup_timeout_sec=60',
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

  it('ends the run soon after its result, with what the binary left running', async () => {
    const root = await mkdtemp(join(tmpdir(), 'awaywork-left-'))
    const pid = join(root, 'left.pid')
    const script = join(root, 'waits.sh')
    const fixture = fileURLToPath(new URL('./fixtures/codex/exec.jsonl', import.meta.url))
    const waits = `[ "$1" = app-server ] && exit 1; cat ${fixture}; /bin/sleep 30 >/dev/null 2>&1 & echo $! > ${pid}; wait`
    await writeFile(script, `#!/bin/sh\n${waits}\n`, { mode: 0o755 })
    const started = Date.now()
    const events = await collect(
      codexProvider(script, lockFile).run(job(), new AbortController().signal),
    )
    expect(Date.now() - started).toBeLessThan(8000)
    expect(events.at(-1)).toMatchObject({ type: 'done', ok: true })
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
    expect(waits).toEqual([`waiting for pid ${process.pid}, which holds ${file}`])
    await release()
    await (await next)()
  })

  it('lends its login to a worker’s home and saves the refreshed one back, under the lock', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'awaywork-codex-login-'))
    const [authFile, held] = [join(dir, 'auth.json'), join(dir, 'codex.lock')]
    const auth = (refresh: string, account = 'acct-1') =>
      JSON.stringify({ tokens: { access_token: 'a', refresh_token: refresh, account_id: account } })
    const lending = codexProvider(bin, held, authFile)
    const lend = async (back: boolean, phase: (codex: string) => Promise<unknown>) => {
      const home = await mkdtemp(join(dir, 'home-'))
      const logs: string[] = []
      const save = await lending.login?.(home, (line) => logs.push(line))
      expect(await readFile(held, 'utf8')).toBe(String(process.pid))
      await phase(join(home, '.codex'))
      await save?.(back)
      expect(existsSync(held)).toBe(false)
      expect(existsSync(join(home, '.codex'))).toBe(!back)
      return logs.join('\n')
    }
    await writeFile(authFile, auth('r0'))
    await lend(true, async (codex) => {
      expect(await readFile(join(codex, 'auth.json'), 'utf8')).toBe(auth('r0'))
      // The run takes no second lock.
      await collect(lending.run(job(), new AbortController().signal))
      await writeFile(join(codex, 'auth.json'), auth('r1'))
    })
    expect(await readFile(authFile, 'utf8')).toBe(auth('r1'))

    const refreshed = (codex: string, account?: string) =>
      writeFile(join(codex, 'auth.json'), auth('r2', account))
    await lend(false, (codex) => refreshed(codex))
    expect(await lend(true, (codex) => refreshed(codex, 'acct-2'))).toContain('account differs')
    await lend(true, async (codex) => {
      await writeFile(join(dir, 'planted.json'), auth('r2'))
      await rm(join(codex, 'auth.json'))
      await symlink(join(dir, 'planted.json'), join(codex, 'auth.json'))
    })
    expect(await readFile(authFile, 'utf8')).toBe(auth('r1'))
    const fifo = await lend(true, async (codex) => {
      await rm(join(codex, 'auth.json'))
      await execa('mkfifo', [join(codex, 'auth.json')])
    })
    expect(fifo).toContain("isn't a small regular file")
    expect(
      await lend(true, async (codex) => {
        await refreshed(codex)
        await writeFile(authFile, auth('mine'))
      }),
    ).toContain('yours changed since it was lent')
    expect(await readFile(authFile, 'utf8')).toBe(auth('mine'))
  })

  it('lends and saves back the login of a CODEX_HOME set in awaywork’s env file', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'awaywork-codex-home-'))
    const [fromEnvFile, fallback] = [join(dir, 'codex-from-env-file'), join(dir, '.codex')]
    await mkdir(fromEnvFile)
    await mkdir(fallback)
    const auth = (refresh: string) =>
      JSON.stringify({ tokens: { refresh_token: refresh, account_id: 'acct-1' } })
    await writeFile(join(fromEnvFile, 'auth.json'), auth('r0'))
    await writeFile(join(fallback, 'auth.json'), auth('home'))
    vi.stubEnv('HOME', dir)
    vi.stubEnv('CODEX_HOME', undefined)
    try {
      const lending = codexProvider(bin, join(dir, 'codex.lock'))
      await writeFile(join(dir, 'env'), `CODEX_HOME=${fromEnvFile}\n`)
      process.loadEnvFile(join(dir, 'env'))
      const home = await mkdtemp(join(dir, 'home-'))
      const save = await lending.login?.(home, () => {})
      expect(await readFile(join(home, '.codex', 'auth.json'), 'utf8')).toBe(auth('r0'))
      await writeFile(join(home, '.codex', 'auth.json'), auth('r1'))
      await save?.(true)
      expect(await readFile(join(fromEnvFile, 'auth.json'), 'utf8')).toBe(auth('r1'))
      expect(await readFile(join(fallback, 'auth.json'), 'utf8')).toBe(auth('home'))
    } finally {
      vi.unstubAllEnvs()
    }
  })

  it('saves back only the tokens of a refresh, never a key, mode or account the worker swapped in', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'awaywork-codex-forged-'))
    const authFile = join(dir, 'auth.json')
    const lending = codexProvider(bin, join(dir, 'codex.lock'), authFile)
    const tokens = (id: string) => ({
      access_token: `a${id}`,
      id_token: `i${id}`,
      refresh_token: `r${id}`,
      account_id: 'acct-1',
    })
    const yours = {
      auth_mode: 'chatgpt',
      OPENAI_API_KEY: null,
      tokens: tokens('0'),
      last_refresh: 't0',
      agent_identity: 'mine',
    }
    const handBack = async (lent: object, worker: object) => {
      await writeFile(authFile, JSON.stringify(lent))
      const home = await mkdtemp(join(dir, 'home-'))
      const save = await lending.login?.(home, () => {})
      await writeFile(join(home, '.codex', 'auth.json'), JSON.stringify(worker))
      await save?.(true)
      return JSON.parse(await readFile(authFile, 'utf8'))
    }
    const forged = {
      ...yours,
      auth_mode: 'apikey',
      OPENAI_API_KEY: 'sk-attacker',
      tokens: tokens('x'),
    }
    expect(await handBack(yours, forged)).toEqual(yours)
    const keyed = { ...yours, OPENAI_API_KEY: 'sk-dev' }
    expect(
      await handBack(keyed, { ...keyed, OPENAI_API_KEY: 'sk-attacker', tokens: tokens('1') }),
    ).toEqual(keyed)

    const refresh = {
      ...yours,
      tokens: tokens('1'),
      last_refresh: 't1',
      agent_identity: 'theirs',
      personal_access_token: 'theirs',
    }
    expect(await handBack(yours, refresh)).toEqual({
      ...yours,
      tokens: tokens('1'),
      last_refresh: 't1',
    })
  })
})
