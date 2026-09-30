import { readFileSync } from 'node:fs'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import type { Job, WorkerEvent } from '../src/core/types.js'
import { claudeProvider, toEvents } from '../src/providers/claude.js'
import { workerEnv } from '../src/worker/workspace.js'
import { providerContract } from './contracts/provider.contract.js'
import { fakeItem } from './fakes/items.js'

const bin = fileURLToPath(new URL('./fakes/claude.mjs', import.meta.url))
const provider = claudeProvider(bin)
const dir = await mkdtemp(join(tmpdir(), 'nightshift-claude-'))
const recorded = (name: string) =>
  readFileSync(new URL(`./fixtures/claude/${name}.jsonl`, import.meta.url), 'utf8').split('\n')

const job = (): Job => ({
  unit: {
    id: 'fake-1',
    items: [fakeItem()],
    repo: 'acme/api',
    base: '',
    foreign: false,
    network: true,
    untrusted: false,
    branch: 'night/fake-1',
    rule: { skill: 'fix-ci', provider: [], skills: [], instructions: [] },
    skill: 'fix-ci',
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

  it('gives the model no forge token, no withheld secret and no gh login', () => {
    const env = workerEnv(
      { PATH: '/bin', GH_TOKEN: 'x', GITHUB_TOKEN: 'y', ASANA_TOKEN: 'z' },
      '/work',
      ['ASANA_TOKEN'],
    )
    expect(env).toEqual({ PATH: '/bin', GH_CONFIG_DIR: '/work/.nightshift/gh' })
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
      }
      const unit = {
        ...job().unit,
        base: 'sessions',
        foreign: !mine,
        network: true,
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

  it('runs Bash in the sandbox, which has no network, when the unit is offline', async () => {
    process.env.FAKE_ARGV = join(dir, 'argv.json')
    try {
      await writeFile(join(dir, 'worker.json'), '{"env":{"A":"1"},"sandbox":{"enabled":false}}')
      const unit = { ...job().unit, network: false }
      const run = { ...job(), unit, config: { settings: 'worker.json' }, configDir: dir }
      await collect(provider.run(run, new AbortController().signal))
      const args = JSON.parse(await readFile(join(dir, 'argv.json'), 'utf8')) as string[]
      expect(JSON.parse(args[args.indexOf('--settings') + 1] as string)).toEqual({
        env: { A: '1' },
        autoMemoryEnabled: false,
        sandbox: { enabled: true, failIfUnavailable: true, allowUnsandboxedCommands: false },
      })
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

  it('reports a failed run when the binary exits without a result', async () => {
    const events = await collect(claudeProvider('false').run(job(), new AbortController().signal))
    expect(events).toEqual([{ type: 'done', ok: false, turns: 0 }])
  })
})
