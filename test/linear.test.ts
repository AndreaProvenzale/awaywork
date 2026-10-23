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
    expect(() => parseConfig(mapped('group/sub/project'))).not.toThrow()
    expect(() => parseConfig(mapped('api'))).toThrow('repo_map')
  })
})
