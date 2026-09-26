import { readFileSync, statSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execa } from 'execa'
import { describe, expect, it } from 'vitest'
import type { Job, WorkerEvent } from '../src/core/types.js'
import {
  authFresh,
  codexProvider,
  lock,
  seedAuth,
  toEvents,
  toQuota,
} from '../src/providers/codex.js'
import { runWorker } from '../src/worker/run.js'
import { providerContract } from './contracts/provider.contract.js'
import { fakeItem } from './fakes/items.js'

const bin = fileURLToPath(new URL('./fakes/codex.mjs', import.meta.url))
const tmp = await mkdtemp(join(tmpdir(), 'nightshift-codex-'))
const lockFile = join(tmp, 'codex.lock')
const provider = codexProvider(bin, lockFile)
const home = join(tmp, 'codex-home')
process.env.CODEX_HOME = home
const refreshed = async (at: Date) => {
  await mkdir(home, { recursive: true })
  await writeFile(join(home, 'auth.json'), JSON.stringify({ last_refresh: at.toISOString() }))
}
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
    branch: 'night/fake-1',
    rule: { skill: 'fix-ci', where: {}, provider: [], skills: [], instructions: [] },
    skill: 'fix-ci',
    skills: [],
    providers: ['codex'],
    instructions: [],
    deliver: 'draft_pr',
  },
  dir: tmp,
  prompt: 'fix it',
  maxTurns,
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

  it('reads quota after every tool call while auth.json is fresh', async () => {
    await refreshed(new Date())
    try {
      const events = await collect(provider.run(job(), new AbortController().signal))
      expect(events.filter((e) => e.type === 'quota')).toHaveLength(4)
    } finally {
      await rm(join(home, 'auth.json'))
    }
  })

  it('stops at the ceiling within a tool call, not after the run', async () => {
    await refreshed(new Date())
    const allowance = {
      kind: 'quota' as const,
      window: '30d',
      used: 0.02,
      ceiling: 0.03,
      nights: 1,
      limits: [],
    }
    try {
      const result = await runWorker(provider, job(), allowance, {
        log: () => {},
        watch: () => ({ stop: async () => {} }),
      })
      expect(result).toMatchObject({ status: 'stopped: quota', turns: 1 })
    } finally {
      await rm(join(home, 'auth.json'))
    }
  })

  it('treats auth.json as fresh for 7 days after its last refresh', async () => {
    const now = Date.parse('2026-01-10T00:00:00Z')
    await refreshed(new Date('2026-01-04T00:00:00Z'))
    expect(await authFresh({ CODEX_HOME: home }, now)).toBe(true)
    await refreshed(new Date('2026-01-02T00:00:00Z'))
    expect(await authFresh({ CODEX_HOME: home }, now)).toBe(false)
    await rm(join(home, 'auth.json'))
    expect(await authFresh({ CODEX_HOME: home }, now)).toBe(false)
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

  it('seeds auth.json only when it is missing', async () => {
    const home = join(tmp, 'home')
    await seedAuth({ CODEX_HOME: home, CODEX_AUTH_JSON: '{"seed":1}' })
    expect(await readFile(join(home, 'auth.json'), 'utf8')).toBe('{"seed":1}')
    expect(statSync(join(home, 'auth.json')).mode & 0o777).toBe(0o600)
    await writeFile(join(home, 'auth.json'), '{"refreshed":1}')
    await seedAuth({ CODEX_HOME: home, CODEX_AUTH_JSON: '{"seed":1}' })
    expect(await readFile(join(home, 'auth.json'), 'utf8')).toBe('{"refreshed":1}')
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
