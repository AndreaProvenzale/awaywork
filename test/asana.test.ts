import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { linkTasks } from '../src/cli/plan.js'
import { parseConfig } from '../src/config/load.js'
import type { Ctx } from '../src/core/types.js'
import { asanaSource } from '../src/sources/asana.js'
import { asanaRoutes, recordedFetch } from './fakes/asana.js'
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

  it('states project, section, tags and custom fields', async () => {
    const [eng12, , eng14] = await items()
    expect(eng12?.fields).toEqual({
      project: ['Backend'],
      section: ['QA'],
      tags: ['backend'],
      created: '2026-01-01T08:00:00.000Z',
      updated: '2026-01-03T08:00:00.000Z',
      'fields.ID': 'ENG-12',
      'fields.Priority': 'High',
      'fields.Estimate': 3,
      'fields.Platforms': ['API', 'Web'],
    })
    expect(eng14?.fields).toMatchObject({
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
      { ...cfg, project_repos: { '13': 'acme/web', '11': 'acme/api' } },
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

  it('waits out a 429 as Retry-After says', async () => {
    const replay = recordedFetch(asanaRoutes())
    let calls = 0
    const limited: typeof fetch = async (input, init) =>
      calls++ === 0
        ? new Response('', { status: 429, headers: { 'Retry-After': '0' } })
        : replay(input, init)
    expect(await asanaSource(limited).items(cfg, ctx)).toHaveLength(3)
    expect(calls).toBe(6)
  })

  it('prefetches task.md with fields and comments', async () => {
    const [eng12] = await items()
    const dir = await mkdtemp(join(tmpdir(), 'nightshift-'))
    await source.prefetch(eng12 as never, dir, ctx)
    const task = await readFile(join(dir, 'task.md'), 'utf8')
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
      `providers: [claude]\nsources: { asana: { workspace: "100", project_repos: { "11": ${repo} } } }`
    expect(() => parseConfig(mapped('acme/api'))).not.toThrow()
    expect(() => parseConfig(mapped('api'))).toThrow('project_repos')
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
    }
    const task = asanaTask(12, {}, { key: 'ENG-12' })
    const issue = fakeItem({ key: 'ENG-12', type: 'issue' })
    await linkTasks([task, issue], fakeForge([pr]), ctx)
    expect(task.linkedPrs.map((p) => p.number)).toEqual([4])
    expect(issue.linkedPrs).toEqual([])
    const failing = { ...fakeForge(), prsFor: () => Promise.reject(new Error('gh: not logged in')) }
    const other = asanaTask(13)
    log.length = 0
    await linkTasks([other], failing, ctx)
    expect(other.linkedPrs).toEqual([])
    expect(log).toEqual(['linking T-13 to PRs: gh: not logged in'])
  })
})
