import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { linkTasks } from '../src/cli/plan.js'
import type { Step } from '../src/cli/triage.js'
import { parseConfig } from '../src/config/load.js'
import type { Ctx } from '../src/core/types.js'
import { asanaSource } from '../src/sources/asana.js'
import { asanaFixture, asanaRoutes, recordedFetch } from './fakes/asana.js'
import { fakeForge } from './fakes/forge.js'
import { asanaTask, fakeItem } from './fakes/items.js'

const log: string[] = []
const ctx: Ctx = { env: { ASANA_TOKEN: 'pat' }, log: (line) => log.push(line) }
const cfg = { workspace: '100', token_env: 'ASANA_TOKEN' }

describe('asana source', () => {
  const http = recordedFetch(asanaRoutes())
  const source = asanaSource(http)
  const items = () => source.items(cfg, ctx)

  it('reads my incomplete tasks in the workspace, every page, with the token', async () => {
    const found = await items()
    expect(found.map((i) => [i.key, i.type, i.status])).toEqual([
      ['ENG-12', 'task', 'QA'],
      ['1202', 'task', 'In progress'],
      ['ENG-14', 'task', 'Current sprint'],
    ])
    const [first, second] = http.calls.filter((c) => /\/tasks\?/.test(c.url))
    const query = new URL(first?.url ?? '').searchParams
    expect(query.get('assignee')).toBe('me')
    expect(query.get('workspace')).toBe('100')
    expect(query.get('limit')).toBe('100')
    expect(Date.parse(query.get('completed_since') ?? '')).not.toBeNaN()
    expect(new URL(second?.url ?? '').searchParams.get('offset')).toBe('eyJwYWdlIjoyfQ')
    expect(first?.headers.Authorization).toBe('Bearer pat')
  })

  it('also reads tasks completed since the time asked, as closed', async () => {
    const page = JSON.parse(asanaFixture('tasks-2.json'))
    page.data[0].completed_at = '2026-10-20T10:00:00.000Z'
    const http = recordedFetch([
      [/\/tasks\?.*offset=eyJwYWdlIjoyfQ/, JSON.stringify(page)],
      ...asanaRoutes(),
    ])
    const since = new Date('2026-10-11T00:00:00.000Z')
    const found = await asanaSource(http).items(cfg, ctx, since)
    const [first] = http.calls.filter((c) => /\/tasks\?/.test(c.url))
    expect(new URL(first?.url ?? '').searchParams.get('completed_since')).toBe(since.toISOString())
    expect(found.map((i) => [i.fields.state, i.fields.closed])).toEqual([
      ['open', undefined],
      ['open', undefined],
      ['closed', '2026-10-20T10:00:00.000Z'],
    ])
  })

  it('states project, section, tags and custom fields', async () => {
    const [eng12, , eng14] = await items()
    expect(eng12?.fields).toEqual({
      project: ['Backend'],
      section: ['QA'],
      blocked: true,
      tags: ['backend'],
      created: '2026-01-01T08:00:00.000Z',
      updated: '2026-01-03T08:00:00.000Z',
      due: '2026-01-10',
      state: 'open',
      'fields.ID': 'ENG-12',
      'fields.Priority': 'High',
      'fields.Estimate': 3,
      'fields.Platforms': ['API', 'Web'],
      'fields.Launch': '2026-02-01',
    })
    expect(eng14?.fields).toMatchObject({
      blocked: false,
      project: ['Backend', 'Roadmap'],
      section: ['Current sprint', 'Q3'],
      tags: ['backend', 'billing'],
    })
    expect(eng12?.labels).toEqual(['backend'])
    expect(eng12?.assignee).toBe('Dev')
  })

  it('reads comments from stories', async () => {
    const [eng12, t1202] = await items()
    const stories = http.calls.find((c) => c.url.includes('/tasks/1201/stories'))
    expect(new URL(stories?.url ?? '').searchParams.get('resource_subtype')).toBe('comment_added')
    expect(eng12?.comments).toEqual([
      { author: 'QA', body: 'Still returns 500 on burst.', at: '2026-01-01T10:00:00.000Z' },
      {
        author: 'unknown',
        body: 'Repro: 30 requests in one second.',
        at: '2026-01-02T09:00:00.000Z',
      },
    ])
    expect(t1202?.comments).toEqual([])
  })

  it('keeps only tasks in the configured projects', async () => {
    const found = await source.items({ ...cfg, projects: ['13'] }, ctx)
    expect(found.map((i) => i.key)).toEqual(['ENG-14'])
  })

  it("states the repo mapped to a task's first mapped project", async () => {
    const found = await source.items(
      { ...cfg, repo_map: { '13': 'acme/web', '11': 'acme/api' } },
      ctx,
    )
    expect(found.map((i) => i.fields.repo)).toEqual(['acme/api', undefined, 'acme/api'])
  })

  it('names the missing token and the API error', async () => {
    await expect(source.items(cfg, { ...ctx, env: {} })).rejects.toThrow('ASANA_TOKEN is not set')
    const denied = JSON.stringify({ errors: [{ message: 'Not Authorized' }] })
    const failing = asanaSource(recordedFetch([[/./, { status: 401, body: denied }]]))
    await expect(failing.items(cfg, ctx)).rejects.toThrow('GET /tasks: 401 Not Authorized')
  })

  it('lists a task without `blocked` when its dependencies fail', async () => {
    const premium = JSON.stringify({ errors: [{ message: 'Payment Required' }] })
    const free = asanaSource(
      recordedFetch([[/\/dependencies\?/, { status: 402, body: premium }], ...asanaRoutes()]),
    )
    log.length = 0
    const found = await free.items(cfg, ctx)
    expect(found).toHaveLength(3)
    expect(found[0]?.fields).not.toHaveProperty('blocked')
    expect(log[0]).toBe(
      "asana: couldn't read the dependencies of 1201: GET /tasks/1201/dependencies: 402 Payment Required",
    )
  })

  it('waits out a 429 as Retry-After says', async () => {
    const replay = recordedFetch(asanaRoutes())
    let calls = 0
    const limited: typeof fetch = async (input, init) =>
      calls++ === 0
        ? new Response('', { status: 429, headers: { 'Retry-After': '0' } })
        : replay(input, init)
    expect(await asanaSource(limited).items(cfg, ctx)).toHaveLength(3)
    expect(calls).toBe(9)
  })

  it('prefetches item.md with fields and comments', async () => {
    const [eng12] = await items()
    const dir = await mkdtemp(join(tmpdir(), 'awaywork-'))
    await source.prefetch(eng12 as never, dir, ctx)
    const task = await readFile(join(dir, 'item.md'), 'utf8')
    expect(task).toContain('# ENG-12: Refill the rate-limit bucket\n\n')
    expect(task).toContain('- section: QA\n')
    expect(task).toContain('- fields.Platforms: API, Web\n')
    expect(task).toContain('Bursts still return 500.')
    expect(task).toContain('### QA, 2026-01-01T10:00:00.000Z\n\nStill returns 500 on burst.')
  })
})

describe('asana config and linking', () => {
  const yaml = (where: string) =>
    `providers: [claude: {}]\nsources: { asana: { workspace: "100" } }\nqueue:\n  - skill: implement\n    where: ${where}`

  it('lets rules match custom fields by name', () => {
    expect(() => parseConfig(yaml('{ section: QA, "fields.Priority": High }'))).not.toThrow()
    expect(() => parseConfig(yaml('{ "fields.Estimate": 3 }'))).not.toThrow()
    expect(() => parseConfig(yaml('{ fields: High }'))).toThrow('unknown key "fields"')
  })

  it('maps projects to repos written as owner/repo', () => {
    const mapped = (repo: string) =>
      `providers: [claude]\nsources: { asana: { workspace: "100", repo_map: { "11": ${repo} } } }`
    expect(() => parseConfig(mapped('acme/api'))).not.toThrow()
    expect(() => parseConfig(mapped('api'))).toThrow('repo_map')
    expect(() => parseConfig(yaml('{ repo: acme/api }'))).not.toThrow()
  })

  it('links a task to my PRs carrying its key, leaving other items alone', async () => {
    const pr = {
      repo: 'acme/api',
      number: 4,
      url: 'https://github.com/acme/api/pull/4',
      branch: 'ENG-12-bucket',
      ours: false,
      mine: true,
      trusted: true,
      fork: false,
    }
    const task = asanaTask(12, {}, { key: 'ENG-12' })
    const issue = fakeItem({ key: 'ENG-12', type: 'issue' })
    const steps: Step[] = []
    await linkTasks([task, issue], fakeForge([pr]), ctx, (step) => steps.push(step))
    expect(task.linkedPrs.map((p) => p.number)).toEqual([4])
    expect(steps).toEqual([
      { name: 'linking PRs', state: 'running', detail: '0/1' },
      { name: 'linking PRs', state: 'done', detail: '1/1' },
    ])
    expect(issue.linkedPrs).toEqual([])
    const failing = { ...fakeForge(), prsFor: () => Promise.reject(new Error('gh: not logged in')) }
    const other = asanaTask(13)
    log.length = 0
    await linkTasks([other], failing, ctx)
    expect(other.linkedPrs).toEqual([])
    expect(log).toEqual(['linking T-13 to PRs: gh: not logged in'])
  })
})

describe('asana writes', () => {
  const sections = (...names: string[]) =>
    JSON.stringify({ data: names.map((name, i) => ({ gid: `5${i}`, name })), next_page: null })
  const writer = (assignee: { gid: string } | null = { gid: '900' }) =>
    recordedFetch([
      [/\/projects\/11\/sections\?/, sections('Ready', 'QA')],
      [/\/projects\/12\/sections\?/, sections('Ready', 'In review')],
      [/\/sections\/51\/addTask$/, '{ "data": {} }'],
      [/\/tasks\/1201\/stories$/, '{ "data": { "gid": "6001" } }'],
      [
        /\/tasks\/1201\?opt_fields=modified_at,assignee$/,
        JSON.stringify({ data: { modified_at: '2026-01-04T08:00:00.000Z', assignee } }),
      ],
    ])
  const task = asanaTask(
    1201,
    {},
    {
      id: '1201',
      raw: {
        assignee: { gid: '900' },
        memberships: [{ project: { gid: '11' } }, { project: { gid: '12' } }],
      },
    },
  )

  it('moves a task to the section with that name in the first of its projects that has one', async () => {
    const http = writer()
    const move = { op: 'move', to: 'in review' } as const
    expect(await asanaSource(http).write?.(cfg, task, move, ctx)).toEqual({
      before: '2026-01-04T08:00:00.000Z',
      after: '2026-01-04T08:00:00.000Z',
    })
    expect(http.calls[0]?.url).toMatch(/\/tasks\/1201\?opt_fields=modified_at,assignee$/)
    const post = http.calls.find((c) => c.body)
    expect(post?.url).toBe('https://app.asana.com/api/1.0/sections/51/addTask')
    expect(JSON.parse(post?.body ?? '')).toEqual({ data: { task: '1201' } })
    await expect(
      asanaSource(writer()).write?.(cfg, task, { op: 'move', to: 'Done' }, ctx),
    ).rejects.toThrow(
      `T-1201's projects have no section "Done", only "Ready", "QA", "Ready", "In review"`,
    )
  })

  it('looks for the section only in the projects the config names', async () => {
    const scoped = { ...cfg, projects: ['11'] }
    await expect(
      asanaSource(writer()).write?.(scoped, task, { op: 'move', to: 'In review' }, ctx),
    ).rejects.toThrow(`T-1201's projects have no section "In review", only "Ready", "QA"`)
  })

  it('refuses a task reassigned or unassigned since it was read', async () => {
    for (const assignee of [{ gid: '901' }, null]) {
      const http = writer(assignee)
      for (const write of [
        { op: 'move', to: 'QA' },
        { op: 'comment', body: 'Q?' },
      ] as const)
        await expect(asanaSource(http).write?.(cfg, task, write, ctx)).rejects.toThrow(
          'T-1201 is no longer yours: not assigned to you',
        )
      expect(http.calls.filter((c) => c.body)).toEqual([])
    }
  })

  it('comments as a story of plain text', async () => {
    const http = writer()
    await asanaSource(http).write?.(cfg, task, { op: 'comment', body: 'Which?\n\nOr?' }, ctx)
    expect(http.calls[1]?.url).toBe('https://app.asana.com/api/1.0/tasks/1201/stories')
    expect(JSON.parse(http.calls[1]?.body ?? '')).toEqual({ data: { text: 'Which?\n\nOr?' } })
  })

  it("marks the assignee's own stories as yours and every task as yours", async () => {
    const mine = JSON.stringify({
      data: [
        {
          created_at: '2026-01-01T10:00:00.000Z',
          created_by: { gid: '900', name: 'Dev' },
          text: 'Q?',
        },
      ],
      next_page: null,
    })
    const found = await asanaSource(
      recordedFetch([[/\/tasks\/1201\/stories\?/, mine], ...asanaRoutes()]),
    ).items(cfg, ctx)
    expect(found[0]?.comments[0]?.mine).toBe(true)
    expect(found.every((i) => i.mine)).toBe(true)
  })
})
