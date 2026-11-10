import { describe, expect, it } from 'vitest'
import { approveItem } from '../src/cli/approve.js'
import { parseConfig } from '../src/config/load.js'
import { markComment, type PostState, planComment, resultComment } from '../src/core/comments.js'
import type { Item, Source, Write } from '../src/core/types.js'
import { fakeItem } from './fakes/items.js'
import { fakeSource } from './fakes/source.js'

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
  it('refuses a bad key, and an item nothing waits on', async () => {
    const { sources, writes } = github([fakeItem({ source: 'github', key: 'acme/api#5' })])
    await expect(approveItem('acme/api#5', config, '', { sources })).rejects.toThrow('source:key')
    await expect(approveItem('jira:X-1', config, '', { sources })).rejects.toThrow('not configured')
    await expect(approveItem('github:acme/api#5', config, '', { sources, ctx })).rejects.toThrow(
      'nothing on github:acme/api#5 waits for your approval',
    )
    expect(writes).toEqual([])
  })

  const plan = {
    author: 'me',
    body: `${planComment('Two tasks.', 'tasks:\n  - id: api\n    title: API')}\n\n— awaywork`,
    at: '2026-01-01T00:00:00Z',
    mine: true as const,
  }
  const card = (...comments: Item['comments']) =>
    fakeItem({ source: 'github', key: 'acme/api#5', mine: true, comments: [plan, ...comments] })

  it('replies approve with the notes on an item waiting on a plan', async () => {
    const { sources, writes } = github([card()])
    expect(
      await approveItem('github:acme/api#5', config, 'Keep the old route.', { sources, ctx }),
    ).toBe(
      'plan approved: replied approve, with your notes, on https://example.com/1#issuecomment-1',
    )
    expect(writes).toEqual([
      ['acme/api#5', { op: 'comment', body: 'approve\nKeep the old route.\n\n— awaywork' }],
    ])
  })

  it('refuses a plan you already answered, or one that went ahead, but not past a teammate', async () => {
    const bot = {
      author: 'ci',
      body: 'Coverage 91%',
      at: '2026-01-02T00:00:00Z',
      bot: true as const,
    }
    const theirs = { author: 'sam', body: 'Split api.', at: '2026-01-03T00:00:00Z' }
    const mine = { ...theirs, author: 'me', mine: true as const }
    const { sources, writes } = github([card(bot, mine)])
    await expect(approveItem('github:acme/api#5', config, '', { sources, ctx })).rejects.toThrow(
      'the plan on https://example.com/1 was already answered by me, 2026-01-03T00:00:00Z',
    )
    const went = {
      ...plan,
      body: markComment(plan.body.replace(/\n\n— awaywork$/, ''), { went: true, gates: [] }),
    }
    const ahead = github([
      fakeItem({ source: 'github', key: 'acme/api#5', mine: true, comments: [went] }),
    ])
    await expect(
      approveItem('github:acme/api#5', config, '', { sources: ahead.sources, ctx }),
    ).rejects.toThrow(
      'the plan on https://example.com/1 went ahead: nothing waits for your approval',
    )
    expect([...writes, ...ahead.writes]).toEqual([])
    const teammate = github([card(theirs)])
    expect(
      await approveItem('github:acme/api#5', config, '', { sources: teammate.sources, ctx }),
    ).toBe('plan approved: replied approve on https://example.com/1#issuecomment-1')
  })

  it("replies approve on a report's result that waits, and refuses one that went ahead", async () => {
    const result = (post: PostState) => ({
      author: 'me',
      body: markComment(
        resultComment('Two flows.', 'done', 'story', undefined, 0, 'waits' in post),
        post,
      ),
      at: '2026-01-01T00:00:00Z',
      mine: true as const,
    })
    const item = (post: PostState) =>
      fakeItem({ source: 'github', key: 'acme/api#7', mine: true, comments: [result(post)] })
    const { sources, writes } = github([item({ waits: true, move: 'Ready', saw: 'open' })])
    expect(await approveItem('github:acme/api#7', config, '', { sources, ctx })).toBe(
      "story's result approved: replied approve on https://example.com/1#issuecomment-1",
    )
    expect(writes).toEqual([['acme/api#7', { op: 'comment', body: 'approve\n\n— awaywork' }]])
    const ahead = github([item({ went: true, gates: ['taste'] })])
    await expect(
      approveItem('github:acme/api#7', config, '', { sources: ahead.sources, ctx }),
    ).rejects.toThrow(/^story's result on https:\/\/example.com\/1 went ahead/)
  })

  it("refuses a plan's task, which the plan's approval covers", async () => {
    const { sources, writes } = github([card()])
    await expect(
      approveItem('github:acme/api#5/api', config, '', { sources, ctx }),
    ).rejects.toThrow(
      'github:acme/api#5/api is a task of the plan on github:acme/api#5: a task takes no approval of its own, approving the plan on the card covers it',
    )
    await expect(
      approveItem('github:acme/api#5/nope', config, '', { sources, ctx }),
    ).rejects.toThrow('the plan on github:acme/api#5 has no task nope')
    expect(writes).toEqual([])
  })
})
