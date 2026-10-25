import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { parseConfig } from '../src/config/load.js'
import type { Ctx } from '../src/core/types.js'
import { linearSource } from '../src/sources/linear.js'
import { recordedFetch } from './fakes/asana.js'
import { linearFetch } from './fakes/linear.js'

const ctx: Ctx = { env: { LINEAR_API_KEY: 'lin_api_key' }, log: () => {} }
const cfg = { token_env: 'LINEAR_API_KEY' }

describe('linear source', () => {
  const http = linearFetch()
  const source = linearSource(http)
  const items = () => source.items(cfg, ctx)

  it('reads my open assigned issues, every page, with the key as is', async () => {
    const found = await items()
    expect(found.map((i) => [i.key, i.type, i.status])).toEqual([
      ['ENG-12', 'task', 'QA'],
      ['WEB-7', 'task', 'Todo'],
    ])
    const [first, second] = http.calls.filter((c) => c.body.includes('query Issues'))
    expect(first?.url).toBe('https://api.linear.app/graphql')
    expect(first?.headers.Authorization).toBe('lin_api_key')
    expect(first?.body).toContain('nin: [\\"completed\\", \\"canceled\\"]')
    expect(JSON.parse(second?.body ?? '{}').variables).toEqual({ after: 'cursor-1' })
  })

  it('states team, state, labels, priority, project and dates', async () => {
    const [eng12, web7] = await items()
    expect(eng12?.fields).toEqual({
      team: 'ENG',
      state: 'QA',
      labels: ['backend', 'bug'],
      priority: 'High',
      blocked: true,
      project: 'Rate limits',
      created: '2026-01-01T08:00:00.000Z',
      updated: '2026-01-03T08:00:00.000Z',
    })
    expect(web7?.fields).toMatchObject({ blocked: false })
    expect(web7?.fields).not.toHaveProperty('project')
    expect(web7?.description).toBe('')
    expect(eng12?.labels).toEqual(['backend', 'bug'])
    expect(eng12?.assignee).toBe('Dev')
  })

  it('reads comments oldest first', async () => {
    const [eng12, web7] = await items()
    expect(eng12?.comments).toEqual([
      { author: 'QA', body: 'Still returns 500 on burst.', at: '2026-01-01T10:00:00.000Z' },
      {
        author: 'unknown',
        body: 'Repro: 30 requests in one second.',
        at: '2026-01-02T09:00:00.000Z',
      },
    ])
    expect(web7?.comments).toEqual([])
  })

  it("states the repo mapped to an issue's team", async () => {
    const found = await source.items({ ...cfg, repo_map: { ENG: 'acme/api' } }, ctx)
    expect(found.map((i) => i.fields.repo)).toEqual(['acme/api', undefined])
  })

  it('names the missing key and the API error', async () => {
    await expect(source.items(cfg, { ...ctx, env: {} })).rejects.toThrow(
      'LINEAR_API_KEY is not set',
    )
    const denied = JSON.stringify({ errors: [{ message: 'Authentication required' }] })
    const failing = linearSource(recordedFetch([[/./, { status: 400, body: denied }]]))
    await expect(failing.items(cfg, ctx)).rejects.toThrow('Linear API: 400 Authentication required')
  })

  it('prefetches item.md with fields and comments', async () => {
    const [eng12] = await items()
    const dir = await mkdtemp(join(tmpdir(), 'awaywork-'))
    await source.prefetch(eng12 as never, dir, ctx)
    const issue = await readFile(join(dir, 'item.md'), 'utf8')
    expect(issue).toContain('# ENG-12: Refill the rate-limit bucket\n\n')
    expect(issue).toContain('- state: QA\n')
    expect(issue).toContain('- labels: backend, bug\n')
    expect(issue).toContain('Bursts still return 500.')
    expect(issue).toContain('### QA, 2026-01-01T10:00:00.000Z\n\nStill returns 500 on burst.')
  })

  it('maps teams to repos written as owner/repo', () => {
    const mapped = (repo: string) =>
      `providers: [claude]\nsources: { linear: { repo_map: { ENG: ${repo} } } }`
    expect(() => parseConfig(mapped('acme/api'))).not.toThrow()
    expect(() => parseConfig(mapped('api'))).toThrow('repo_map')
  })
})

describe('linear writes', () => {
  const states = {
    nodes: [
      { id: 's1', name: 'Todo' },
      { id: 's2', name: 'In Review' },
    ],
  }
  const writer = () =>
    recordedFetch([
      [
        /query States/,
        JSON.stringify({
          data: { issue: { updatedAt: '2026-01-03T08:00:00.000Z', team: { states } } },
        }),
      ],
      [/mutation (IssueMove|CommentCreate)/, '{ "data": { "x": { "success": true } } }'],
      [/query Updated/, '{ "data": { "issue": { "updatedAt": "2026-01-04T08:00:00.000Z" } } }'],
    ])
  const eng12 = { id: 'issue-12', key: 'ENG-12' } as never
  const sent = (http: ReturnType<typeof writer>) => http.calls.map((c) => JSON.parse(c.body))

  it("moves an issue to its team's workflow state with that name", async () => {
    const http = writer()
    const move = { op: 'move', to: 'in review' } as const
    expect(await linearSource(http).write?.(cfg, eng12, move, ctx)).toEqual({
      before: '2026-01-03T08:00:00.000Z',
      after: '2026-01-04T08:00:00.000Z',
    })
    expect(sent(http)[1]?.variables).toEqual({ id: 'issue-12', stateId: 's2' })
    await expect(
      linearSource(writer()).write?.(cfg, eng12, { op: 'move', to: 'QA' }, ctx),
    ).rejects.toThrow(`ENG-12's team has no state "QA", only "Todo", "In Review"`)
  })

  it('comments with the body as Markdown', async () => {
    const http = writer()
    await linearSource(http).write?.(cfg, eng12, { op: 'comment', body: 'Which?' }, ctx)
    expect(sent(http).map((b) => b.query.split('(')[0])).toEqual([
      'query Updated',
      'mutation CommentCreate',
      'query Updated',
    ])
    expect(sent(http)[1]?.variables).toEqual({ issueId: 'issue-12', body: 'Which?' })
  })

  it('marks your own comments as yours and every issue as yours', async () => {
    const comments = {
      nodes: [
        { body: 'Q?', createdAt: '2026-01-01T10:00:00.000Z', user: { name: 'Dev', isMe: true } },
      ],
      pageInfo: { hasNextPage: false, endCursor: null },
    }
    const http = linearFetch([
      [/query Comments/, JSON.stringify({ data: { issue: { comments } } })],
    ])
    const [found] = await linearSource(http).items(cfg, ctx)
    expect(found?.comments[0]?.mine).toBe(true)
    expect(found?.mine).toBe(true)
  })
})
