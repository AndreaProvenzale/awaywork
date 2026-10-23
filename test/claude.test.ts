import { readFileSync } from 'node:fs'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execa } from 'execa'
import { describe, expect, it, vi } from 'vitest'
import type { Job, WorkerEvent } from '../src/core/types.js'
import { claudeProvider, toEvents } from '../src/providers/claude.js'
import { commandEnv, workerEnv } from '../src/worker/workspace.js'
import { providerContract } from './contracts/provider.contract.js'
import { fakeItem } from './fakes/items.js'

const bin = fileURLToPath(new URL('./fakes/claude.mjs', import.meta.url))
const provider = claudeProvider(bin)
const dir = await mkdtemp(join(tmpdir(), 'awaywork-claude-'))
const recorded = (name: string) =>
  readFileSync(new URL(`./fixtures/claude/${name}.jsonl`, import.meta.url), 'utf8').split('\n')

const job = (): Job => ({
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
    providers: ['claude'],
    instructions: [],
    deliver: 'draft_pr',
  },
  dir,
  prompt: 'fix it',
  maxTurns: 2,
  env: process.env,
})

providerContract(provider, job)

async function collect(events: AsyncIterable<WorkerEvent>): Promise<WorkerEvent[]> {
  const all: WorkerEvent[] = []
  for await (const e of events) all.push(e)
  return all
}

describe('claude provider', () => {
  it('turns a recorded run into tool logs, quota and a done event', () => {
    expect(recorded('max-turns').flatMap(toEvents)).toEqual([
      { type: 'log', line: 'Bash: ls' },
      { type: 'log', line: 'Bash: pwd' },
      {
        type: 'quota',
        quota: {
          windows: [
            { name: 'five_hour', span: 'short', used: 0.03, resetsAt: 1790374800 },
            { name: 'seven_day', span: 'long', used: 0.05, resetsAt: 1790676000 },
          ],
        },
      },
      { type: 'log', line: 'result: error_max_turns' },
      { type: 'done', ok: false, turns: 3 },
    ])
    expect(toEvents('not json')).toEqual([])
  })

  it('reads the version and probes both windows from one Haiku turn', async () => {
    expect(await provider.detect()).toEqual({ installed: true, version: '2.1.282' })
    expect(await claudeProvider('/nonexistent/claude').detect()).toEqual({ installed: false })
    expect(await provider.probe({ env: process.env, log: () => {} })).toEqual({
      windows: [
        { name: 'five_hour', span: 'short', used: 0.02, resetsAt: 1790374800 },
        { name: 'seven_day', span: 'long', used: 0.05, resetsAt: 1790676000 },
      ],
    })
  })

  it('kills the binary when aborted mid-run', async () => {
    process.env.FAKE_CLAUDE_HANG = '1'
    const abort = new AbortController()
    const events: WorkerEvent[] = []
    try {
      for await (const e of provider.run(job(), abort.signal)) {
        events.push(e)
        abort.abort()
      }
    } finally {
      delete process.env.FAKE_CLAUDE_HANG
    }
    expect(events.at(-1)).toEqual({ type: 'done', ok: false, turns: 0 })
  })

  it('gives the model no forge token, no withheld secret and no gh or twg login, only placeholder tokens', () => {
    const developer = {
      PATH: '/bin',
      GH_TOKEN: 'x',
      GITHUB_TOKEN: 'y',
      ASANA_TOKEN: 'z',
      TWG_BBC_TOKEN: 'b',
      TWG_PROFILE: 'p',
      TWG_STATLAS_TOKEN: 's',
      TWG_KEY_CONTENT: 'k',
      TWG_CONFIG_DIR: '/home/me/.config/twg',
    }
    const env = workerEnv(developer, '/work', ['ASANA_TOKEN'])
    expect(
      Object.keys(commandEnv(developer, '/work', ['ASANA_TOKEN'])).filter((name) =>
        name.startsWith('TWG_'),
      ),
    ).toEqual(['TWG_CONFIG_DIR'])
    expect(env).toEqual({
      PATH: '/bin',
      GH_CONFIG_DIR: '/work/.away/gh',
      GH_TOKEN: 'none',
      GH_ENTERPRISE_TOKEN: 'none',
      TWG_CONFIG_DIR: '/work/.away/twg',
      GIT_CONFIG_GLOBAL: '/work/.away/gitconfig',
      GIT_CONFIG_NOSYSTEM: '1',
    })
  })

  it("gives the model no askpass helper, ssh agent or developer's git config; setup keeps them", () => {
    const plumbing = {
      SSH_ASKPASS: '/askpass',
      GIT_ASKPASS: '/askpass',
      GIT_CONFIG_PARAMETERS: "'credential.helper'='store'",
      GIT_CONFIG_COUNT: '1',
      GIT_CONFIG_KEY_0: 'credential.helper',
      GIT_CONFIG_VALUE_0: 'store',
    }
    const env = { PATH: '/bin', GIT_CONFIG_GLOBAL: '/g', SSH_AUTH_SOCK: '/agent.sock', ...plumbing }
    expect(workerEnv(env, '/work', [])).toEqual({
      PATH: '/bin',
      GIT_CONFIG_GLOBAL: '/work/.away/gitconfig',
      GIT_CONFIG_NOSYSTEM: '1',
      GH_CONFIG_DIR: '/work/.away/gh',
      GH_TOKEN: 'none',
      GH_ENTERPRISE_TOKEN: 'none',
      TWG_CONFIG_DIR: '/work/.away/twg',
    })
    expect(commandEnv(env, '/work', [])).toEqual({
      ...env,
      GH_CONFIG_DIR: '/work/.away/gh',
      GH_TOKEN: 'none',
      GH_ENTERPRISE_TOKEN: 'none',
      TWG_CONFIG_DIR: '/work/.away/twg',
    })
  })

  it("commits as the identity the action puts in the job's env, with no git config at all", async () => {
    const repo = await mkdtemp(join(tmpdir(), 'awaywork-identity-'))
    const email = '583231+octocat@users.noreply.github.com'
    const job = {
      PATH: process.env.PATH,
      HOME: repo,
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_AUTHOR_NAME: 'octocat',
      GIT_AUTHOR_EMAIL: email,
      GIT_COMMITTER_NAME: 'octocat',
      GIT_COMMITTER_EMAIL: email,
    }
    const env = workerEnv(job, repo, [])
    const git = (...args: string[]) =>
      execa('git', ['-C', repo, ...args], { env, extendEnv: false })
    await git('init', '-q')
    await git('commit', '-q', '--allow-empty', '-m', 'work')
    expect((await git('log', '--format=%an <%ae>|%cn <%ce>')).stdout).toBe(
      `octocat <${email}>|octocat <${email}>`,
    )
  })

  it('passes the model only when one is set', async () => {
    process.env.FAKE_ARGV = join(dir, 'argv.json')
    const argv = async (model?: string) => {
      await collect(provider.run({ ...job(), model }, new AbortController().signal))
      return JSON.parse(await readFile(join(dir, 'argv.json'), 'utf8')) as string[]
    }
    try {
      expect((await argv('opus')).join(' ')).toContain('--model opus')
      expect(await argv()).not.toContain('--model')
    } finally {
      delete process.env.FAKE_ARGV
    }
  })

  it("turns the account's claude.ai connectors off, in a run and a probe", async () => {
    const file = join(dir, 'connectors')
    process.env.FAKE_CONNECTORS = file
    try {
      await collect(provider.run(job(), new AbortController().signal))
      expect(await readFile(file, 'utf8')).toBe('false')
      await rm(file)
      await provider.probe({ env: process.env, log: () => {} })
      expect(await readFile(file, 'utf8')).toBe('false')
    } finally {
      delete process.env.FAKE_CONNECTORS
    }
  })

  it("loads the repo's config but not ~/.claude; neither on someone else's PR or a probe", async () => {
    process.env.FAKE_ARGV = join(dir, 'argv.json')
    const argv = async (mine: boolean) => {
      const pr = {
        repo: 'acme/api',
        number: 2,
        url: 'u',
        branch: 'sessions',
        ours: false,
        mine,
        trusted: true,
        fork: false,
      }
      const unit = {
        ...job().unit,
        base: 'sessions',
        foreign: !mine,
        untrusted: false,
        items: [fakeItem({ linkedPrs: [pr] })],
      }
      await collect(provider.run({ ...job(), unit }, new AbortController().signal))
      return JSON.parse(await readFile(join(dir, 'argv.json'), 'utf8')) as string[]
    }
    const flag = (args: string[], name: string) => args[args.indexOf(name) + 1]
    try {
      const own = await argv(true)
      expect(flag(own, '--setting-sources')).toBe('project,local')
      expect(flag(own, '--settings')).toBe('{"autoMemoryEnabled":false}')
      expect(own).not.toContain('--strict-mcp-config')
      const foreign = await argv(false)
      expect(flag(foreign, '--setting-sources')).toBe('')
      expect(foreign).toContain('--strict-mcp-config')
      await provider.probe({ env: process.env, log: () => {} })
      const probe = JSON.parse(await readFile(join(dir, 'argv.json'), 'utf8')) as string[]
      expect(flag(probe, '--setting-sources')).toBe('')
    } finally {
      delete process.env.FAKE_ARGV
    }
  })

  it('passes the settings file with auto-memory off, and the skills plugin', async () => {
    process.env.FAKE_ARGV = join(dir, 'argv.json')
    await writeFile(join(dir, 'worker.json'), '{"env":{"A":"1"},"autoMemoryEnabled":true}')
    const plugin = join(dir, 'plugin')
    try {
      const run = { ...job(), config: { settings: 'worker.json' }, configDir: dir, plugin }
      await collect(provider.run(run, new AbortController().signal))
      const args = JSON.parse(await readFile(join(dir, 'argv.json'), 'utf8')) as string[]
      expect(args[args.indexOf('--settings') + 1]).toBe(
        '{"env":{"A":"1"},"autoMemoryEnabled":false}',
      )
      expect(args[args.indexOf('--plugin-dir') + 1]).toBe(plugin)
    } finally {
      delete process.env.FAKE_ARGV
    }
  })

  it("passes the unit's MCP servers on someone else's PR too, allowing only their tools", async () => {
    process.env.FAKE_ARGV = join(dir, 'argv.json')
    try {
      const mcp = {
        db: { command: 'npx', args: ['db-mcp'], secrets: ['DATABASE_URL'], tools: ['query'] },
        sentry: {
          url: 'https://mcp.sentry.dev/mcp',
          headers: { Authorization: 'Bearer ${SENTRY_TOKEN}' },
          secrets: ['SENTRY_TOKEN'],
        },
      }
      const unit = { ...job().unit, foreign: true }
      await collect(provider.run({ ...job(), unit, mcp }, new AbortController().signal))
      const args = JSON.parse(await readFile(join(dir, 'argv.json'), 'utf8')) as string[]
      const flag = (name: string) => args[args.indexOf(name) + 1]
      expect(JSON.parse(flag('--mcp-config') as string)).toEqual({
        mcpServers: {
          db: { command: 'npx', args: ['db-mcp'] },
          sentry: {
            type: 'http',
            url: 'https://mcp.sentry.dev/mcp',
            headers: { Authorization: 'Bearer ${SENTRY_TOKEN}' },
          },
        },
      })
      expect(flag('--allowedTools')).toBe(
        'Bash Read Edit Write Grep Glob Skill mcp__db__query mcp__sentry',
      )
      expect(flag('--permission-mode')).toBe('dontAsk')
      expect(args).toContain('--strict-mcp-config')
    } finally {
      delete process.env.FAKE_ARGV
    }
  })

  it('logs an MCP call with its arguments', () => {
    const line = JSON.stringify({
      type: 'assistant',
      message: {
        content: [{ type: 'tool_use', name: 'mcp__sentry__search', input: { query: 'crash' } }],
      },
    })
    expect(toEvents(line)).toEqual([
      { type: 'log', line: 'mcp__sentry__search: {"query":"crash"}' },
    ])
  })

  it('reports a failed run when the binary exits without a result', async () => {
    const events = await collect(claudeProvider('false').run(job(), new AbortController().signal))
    expect(events).toEqual([{ type: 'done', ok: false, turns: 0 }])
  })

  it('kills what the binary left running once it exits', async () => {
    const root = await mkdtemp(join(tmpdir(), 'awaywork-left-'))
    const pid = join(root, 'left.pid')
    const script = join(root, 'leaves.sh')
    const leaves = `/bin/sleep 30 >/dev/null 2>&1 & echo $! > ${pid}`
    await writeFile(script, `#!/bin/sh\n${leaves}\n`, { mode: 0o755 })
    await collect(claudeProvider(script).run(job(), new AbortController().signal))
    const left = Number(await readFile(pid, 'utf8'))
    await vi.waitFor(() => expect(() => process.kill(left, 0)).toThrow(), { timeout: 2000 })
  })
})
