import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, it, vi } from 'vitest'
import type { Job, WorkerEvent } from '#core/types'
import { claudeProvider } from '#providers/claude'
import { cursorProvider } from '#providers/cursor'
import { fakeItem } from './fakes/items'

vi.mock('#core/isolation/index', async (original) => ({
  ...(await original<typeof import('#core/isolation/index')>()),
  wallUp: () => true,
}))

const fake = (name: string) => fileURLToPath(new URL(`./fakes/${name}.mjs`, import.meta.url))
const dir = await mkdtemp(join(tmpdir(), 'awaywork-wall-providers-'))
const job = (env: NodeJS.ProcessEnv = {}): Job => ({
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
    network: ['pypi.org'],
  },
  dir,
  prompt: 'fix it',
  maxTurns: 2,
  env: { ...process.env, ...env },
})

async function collect(events: AsyncIterable<WorkerEvent>): Promise<WorkerEvent[]> {
  const all: WorkerEvent[] = []
  for await (const e of events) all.push(e)
  return all
}

it("leaves Claude's telemetry out behind the wall, which would refuse it at every run", async () => {
  const file = join(dir, 'telemetry')
  const provider = claudeProvider(fake('claude'), async () => true)
  await collect(provider.run(job({ FAKE_TELEMETRY: file }), new AbortController().signal))
  expect(await readFile(file, 'utf8')).toBe('1')
})

it("runs Cursor's shell behind the wall, not in its own sandbox, which can't use awaywork's proxy", async () => {
  const provider = cursorProvider(fake('cursor'), async () => true)
  await provider.prepare?.(job())
  const home = join(dir, '.away/agent-home/.cursor')
  expect(JSON.parse(await readFile(join(home, 'cli-config.json'), 'utf8'))).toEqual({
    version: 1,
    permissions: { allow: ['Shell(*)', 'Read(**)', 'Write(**)'], deny: [] },
  })
  await expect(readFile(join(home, 'sandbox.json'))).rejects.toThrow()
  const events = await collect(provider.run(job(), new AbortController().signal))
  expect(events[0]).toEqual({
    type: 'log',
    line: "Cursor's sandbox can't use awaywork's proxy: its shell runs behind the network wall instead",
  })
})
