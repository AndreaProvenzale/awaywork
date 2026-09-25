import { readFileSync } from 'node:fs'
import { mkdtemp } from 'node:fs/promises'
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
    branch: 'night/fake-1',
    rule: { skill: 'fix-ci', where: {}, provider: [], skills: [], instructions: [] },
    skill: 'fix-ci',
    skills: [],
    providers: ['claude'],
    instructions: [],
    deliver: 'draft_pr',
  },
  dir,
  prompt: 'fix it',
  maxTurns: 2,
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

  it('gives the model no forge token and no gh login', () => {
    const env = workerEnv({ PATH: '/bin', GH_TOKEN: 'x', GITHUB_TOKEN: 'y' }, '/work')
    expect(env).toEqual({ PATH: '/bin', GH_CONFIG_DIR: '/work/.nightshift/gh' })
  })

  it('reports a failed run when the binary exits without a result', async () => {
    const events = await collect(claudeProvider('false').run(job(), new AbortController().signal))
    expect(events).toEqual([{ type: 'done', ok: false, turns: 0 }])
  })
})
