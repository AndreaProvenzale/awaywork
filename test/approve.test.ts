import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { approveItem } from '../src/cli/approve.js'
import { parseConfig } from '../src/config/load.js'
import { clearApprovals, withApprovals } from '../src/core/approvals.js'
import { planComment } from '../src/core/footer.js'
import { fieldValue } from '../src/core/queue.js'
import type { RunReport } from '../src/core/report.js'
import type { Item, Source, Write } from '../src/core/types.js'
import { fakeItem } from './fakes/items.js'
import { fakeSource } from './fakes/source.js'

const item = (source: string, key: string, approved = false) =>
  ({ source, key, fields: { approved } }) as unknown as Item

const ctx = { env: {}, log: () => {} }
const config = parseConfig(`
providers: [claude: {}]
sources: { github: { repos: [acme/*] } }
queue: [{ skill: plan, deliver: plan }, { skill: implement, where: { planned: true } }]
`)

/** A GitHub source of `items` that records its writes. */
function github(items: Item[] = []) {
  const writes: [string, Write][] = []
  const source: Source = {
    ...fakeSource(items),
    id: 'github',
    write: async (_cfg, item, write) => {
      writes.push([item.key, write])
      return { url: `${item.url}#issuecomment-1` }
    },
  }
  return { writes, sources: { github: source } }
}

describe('approve', () => {
  it('records an approval by source:key and refuses a bad key', async () => {
    const path = join(await mkdtemp(join(tmpdir(), 'awaywork-')), 'approvals.json')
    const { sources, writes } = github()
    expect(await approveItem('github:acme/api#5', config, '', { path, sources, ctx })).toBe(
      'github:acme/api#5 is approved until a unit on it finishes',
    )
    expect(JSON.parse(await readFile(path, 'utf8'))).toEqual({ 'github:acme/api#5': true })
    expect(writes).toEqual([])
    await expect(approveItem('acme/api#5', config, '', { path, sources })).rejects.toThrow(
      'source:key',
    )
    await expect(approveItem('jira:X-1', config, '', { path, sources })).rejects.toThrow(
      'not configured',
    )
  })

  it('reads no source without a plan rule that can take its items', async () => {
    const path = join(await mkdtemp(join(tmpdir(), 'awaywork-')), 'approvals.json')
    const down: Source = {
      ...fakeSource(),
      id: 'github',
      items: async () => {
        throw new Error('github is down')
      },
    }
    const elsewhere = parseConfig(`
providers: [claude: {}]
sources: { github: { repos: [acme/*] }, tracker: { command: 'echo []', write: 'cat' } }
queue: [{ skill: implement }, { skill: plan, deliver: plan, source: tracker }, { skill: implement, where: { planned: true } }]
`)
    expect(
      await approveItem('github:acme/api#5', elsewhere, '', {
        path,
        sources: { github: down },
        ctx,
      }),
    ).toBe('github:acme/api#5 is approved until a unit on it finishes')
    await expect(
      approveItem('github:acme/api#5', config, '', { path, sources: { github: down }, ctx }),
    ).rejects.toThrow('github is down')
  })

  const plan = {
    author: 'me',
    body: `${planComment('Two tasks.', 'tasks:\n  - id: api\n    title: API')}\n\n— awaywork`,
    at: '2026-01-01T00:00:00Z',
    mine: true as const,
  }
  const card = (...comments: Item['comments']) =>
    fakeItem({ source: 'github', key: 'acme/api#5', mine: true, comments: [plan, ...comments] })

  it('replies approve with the notes on an item waiting on a plan, and approves nothing locally', async () => {
    const path = join(await mkdtemp(join(tmpdir(), 'awaywork-')), 'approvals.json')
    const { sources, writes } = github([card()])
    expect(
      await approveItem('github:acme/api#5', config, 'Keep the old route.', {
        path,
        sources,
        ctx,
      }),
    ).toBe(
      'plan approved: replied approve, with your notes, on https://example.com/1#issuecomment-1',
    )
    expect(writes).toEqual([
      ['acme/api#5', { op: 'comment', body: 'approve\nKeep the old route.\n\n— awaywork' }],
    ])
    await expect(readFile(path, 'utf8')).rejects.toThrow()
  })

  it('refuses a plan already answered, and notes without a plan', async () => {
    const bot = {
      author: 'ci',
      body: 'Coverage 91%',
      at: '2026-01-02T00:00:00Z',
      bot: true as const,
    }
    const reply = { author: 'sam', body: 'Split api.', at: '2026-01-03T00:00:00Z' }
    const { sources, writes } = github([card(bot, reply), fakeItem({ key: 'acme/api#6' })])
    await expect(approveItem('github:acme/api#5', config, '', { sources, ctx })).rejects.toThrow(
      'the plan on https://example.com/1 was already answered by sam, 2026-01-03T00:00:00Z',
    )
    await expect(
      approveItem('github:acme/api#6', config, 'Notes.', { sources, ctx }),
    ).rejects.toThrow("github:acme/api#6 waits on no plan: notes go only with a plan's approval")
    expect(writes).toEqual([])
  })

  it("refuses a plan's task, which the plan's approval covers", async () => {
    const path = join(await mkdtemp(join(tmpdir(), 'awaywork-')), 'approvals.json')
    const { sources, writes } = github([card()])
    await expect(
      approveItem('github:acme/api#5/api', config, '', { path, sources, ctx }),
    ).rejects.toThrow(
      'github:acme/api#5/api is a task of the plan on github:acme/api#5: a task takes no approval of its own, approving the plan on the card covers it',
    )
    await expect(
      approveItem('github:acme/api#5/nope', config, '', { path, sources, ctx }),
    ).rejects.toThrow('the plan on github:acme/api#5 has no task nope')
    expect(writes).toEqual([])
    await expect(readFile(path, 'utf8')).rejects.toThrow()
  })

  it('sets the `approved` field on approved items only', () => {
    const items = withApprovals([item('github', 'a#1'), item('github', 'a#2')], {
      'github:a#1': true,
    })
    expect(items.map((i) => fieldValue(i, 'approved'))).toEqual([true, false])
  })

  // A run with one chain per item, from its steps' results.
  const run = (...chains: [key: string, approved: boolean, ...steps: object[]][]) => {
    const units: object[] = []
    const results: object[] = []
    for (const [key, approved, ...steps] of chains) {
      const items = [item('github', key, approved)]
      steps.forEach((step, n) => {
        const planned = { unit: { id: `${key}-${n}`, items }, ...(n > 0 && { chain: `${key}-0` }) }
        units.push(planned)
        results.push({ planned, ...step })
      })
    }
    return { plan: { units }, results } as unknown as RunReport
  }
  const approvals: Record<string, true> = { 'github:a#1': true, 'github:a#2': true }
  const done = { status: 'done' }

  it('clears the approval of items a chain finished on, not one a later step failed', () => {
    const report = run(['a#1', true, done, done], ['a#2', true, done, { status: 'failed' }])
    expect(clearApprovals(approvals, report)).toEqual({ 'github:a#2': true })
  })

  it('clears it when a failed step finished on its retry', () => {
    const report = run(['a#1', true, done, { status: 'failed', retried: true }, done])
    expect(clearApprovals(approvals, report)).toEqual({ 'github:a#2': true })
  })

  it('keeps an approval given after the run was planned', () => {
    expect(clearApprovals(approvals, run(['a#1', false, done, done]))).toEqual(approvals)
  })
})
