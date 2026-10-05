import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { parseConfig } from '../src/config/load.js'
import type { Ctx } from '../src/core/types.js'
import { adfToMarkdown, jiraSource } from '../src/sources/jira.js'
import { recordedFetch } from './fakes/asana.js'
import { scriptedAsk } from './fakes/ask.js'
import { jiraFetch, jiraFixture } from './fakes/jira.js'

const ctx: Ctx = { env: { JIRA_API_TOKEN: 'atl-token' }, log: () => {} }
const cfg = { site: 'acme.atlassian.net', email: 'dev@acme.test', token_env: 'JIRA_API_TOKEN' }

type Adf = Parameters<typeof adfToMarkdown>[0]
const text = (t: string, marks?: Adf['marks']): Adf => ({ type: 'text', text: t, marks })
const para = (...content: Adf[]): Adf => ({ type: 'paragraph', content })

describe('jira source', () => {
  const http = jiraFetch()
  const source = jiraSource(http)
  const items = () => source.items(cfg, ctx)

  it('searches my unresolved issues with JQL, every page, keyed by issue key', async () => {
    const found = await items()
    expect(found.map((i) => [i.key, i.type, i.status, i.url])).toEqual([
      ['ENG-12', 'task', 'QA', 'https://acme.atlassian.net/browse/ENG-12'],
      ['WEB-7', 'task', 'To Do', 'https://acme.atlassian.net/browse/WEB-7'],
    ])
    const [first, second] = http.calls.filter((c) => c.url.endsWith('/search/jql'))
    expect(first?.url).toBe('https://acme.atlassian.net/rest/api/3/search/jql')
    expect(first?.headers.Authorization).toBe(
      `Basic ${Buffer.from('dev@acme.test:atl-token').toString('base64')}`,
    )
    expect(JSON.parse(first?.body ?? '{}')).toEqual({
      jql: 'assignee = currentUser() AND resolution = Unresolved ORDER BY updated DESC',
      fields: ['*all', '-comment'],
      maxResults: 100,
    })
    expect(JSON.parse(second?.body ?? '{}').nextPageToken).toBe('token-2')
  })

  it('narrows the search with the configured JQL and calls the gateway for a scoped token', async () => {
    const http = jiraFetch()
    await jiraSource(http).items({ ...cfg, jql: 'project = ENG', cloud_id: 'c1' }, ctx)
    const [search] = http.calls.filter((c) => c.url.endsWith('/search/jql'))
    expect(search?.url).toBe('https://api.atlassian.com/ex/jira/c1/rest/api/3/search/jql')
    expect(JSON.parse(search?.body ?? '{}').jql).toBe(
      'assignee = currentUser() AND resolution = Unresolved AND (project = ENG) ORDER BY updated DESC',
    )
  })

  it('states project, status, labels, priority, issue type, dates and custom fields', async () => {
    const [eng12, web7] = await items()
    expect(eng12?.fields).toEqual({
      project: 'ENG',
      status: 'QA',
      labels: ['backend', 'bug'],
      priority: 'High',
      blocked: true,
      issuetype: 'Bug',
      created: '2026-01-01T08:00:00.000Z',
      updated: '2026-01-03T08:30:00.000Z',
      'fields.Story point estimate': 3,
      'fields.Sprint': ['Sprint 7'],
      'fields.Team': 'Platform',
    })
    expect(web7?.fields).toEqual({
      project: 'WEB',
      status: 'To Do',
      labels: [],
      blocked: false,
      issuetype: 'Story',
      created: '2026-01-02T08:00:00.000Z',
      updated: '2026-01-02T09:00:00.000Z',
    })
    expect(eng12?.description).toBe('Bursts still return `500`.\n\n- 30 requests\n- in one second')
    expect(web7?.description).toBe('')
    expect(eng12?.assignee).toBe('Dev')
  })

  it('reads comments as Markdown', async () => {
    const [eng12, web7] = await items()
    expect(eng12?.comments).toEqual([
      { author: 'QA', body: '@Dev still returns 500 on **burst**', at: '2026-01-01T10:00:00.000Z' },
      {
        author: 'unknown',
        body: '```sh\nab -n 30 -c 30 /api\n```',
        at: '2026-01-02T09:00:00.000Z',
      },
    ])
    expect(web7?.comments).toEqual([])
  })

  it("states the repo mapped to an issue's project", async () => {
    const found = await source.items({ ...cfg, project_repos: { ENG: 'acme/api' } }, ctx)
    expect(found.map((i) => i.fields.repo)).toEqual(['acme/api', undefined])
  })

  it('waits out a 429 as Retry-After says', async () => {
    let limited = false
    const inner = jiraFetch()
    const http = (async (input: string | URL | Request, init?: RequestInit) => {
      if (limited) return inner(input, init)
      limited = true
      return new Response('', { status: 429, headers: { 'Retry-After': '0' } })
    }) as typeof fetch
    expect(await jiraSource(http).items(cfg, ctx)).toHaveLength(2)
  })

  it('gives up after the third 429', async () => {
    const http = recordedFetch([[/./, { status: 429, body: '', headers: { 'Retry-After': '0' } }]])
    await expect(jiraSource(http).items(cfg, ctx)).rejects.toThrow('Jira /rest/api/3/field: 429')
    expect(http.calls).toHaveLength(3)
  })

  it('stops paging the search on isLast, an empty page or a repeated token', async () => {
    const searches = async (page: string) => {
      const http = jiraFetch([[/\/search\/jql$/, page]])
      await jiraSource(http).items(cfg, ctx)
      return http.calls.filter((c) => c.url.endsWith('/search/jql')).length
    }
    const first = JSON.parse(jiraFixture('search-1.json'))
    expect(await searches(JSON.stringify({ ...first, isLast: true }))).toBe(1)
    expect(await searches(JSON.stringify({ ...first, issues: [] }))).toBe(1)
    expect(await searches(jiraFixture('search-1.json'))).toBe(2)
  })

  it('pages comments past the first and sorts them by creation', async () => {
    const [one, two] = JSON.parse(jiraFixture('comments-10012.json')).comments
    const page = (startAt: number, comments: unknown[]) =>
      JSON.stringify({ startAt, maxResults: 100, total: 3, comments })
    const earliest = { ...one, created: '2026-01-01T09:00:00.000+0000' }
    const http = jiraFetch([
      [/\/issue\/10012\/comment\?startAt=0&/, page(0, [two, one])],
      [/\/issue\/10012\/comment\?startAt=2&/, page(2, [earliest])],
    ])
    const [eng12] = await jiraSource(http).items(cfg, ctx)
    expect(eng12?.comments.map((c) => c.at)).toEqual([
      '2026-01-01T09:00:00.000Z',
      '2026-01-01T10:00:00.000Z',
      '2026-01-02T09:00:00.000Z',
    ])
  })

  it('keys custom fields that share a name by name and id', async () => {
    const fields = JSON.parse(jiraFixture('fields.json'))
    const search = JSON.parse(jiraFixture('search-1.json'))
    search.issues[0].fields.customfield_10060 = { value: 'Billing' }
    const http = jiraFetch([
      [
        /\/field$/,
        JSON.stringify([...fields, { id: 'customfield_10060', name: 'Team', custom: true }]),
      ],
      [/\/search\/jql$/, JSON.stringify({ ...search, isLast: true })],
    ])
    const [eng12] = await jiraSource(http).items(cfg, ctx)
    expect(eng12?.fields).toMatchObject({
      'fields.Team (customfield_10040)': 'Platform',
      'fields.Team (customfield_10060)': 'Billing',
    })
    expect(eng12?.fields).not.toHaveProperty(['fields.Team'])
  })

  it('names the missing token and the API error', async () => {
    await expect(source.items(cfg, { ...ctx, env: {} })).rejects.toThrow(
      'JIRA_API_TOKEN is not set',
    )
    const denied = JSON.stringify({ errorMessages: ['You are not authorized'] })
    const failing = jiraSource(recordedFetch([[/./, { status: 401, body: denied }]]))
    await expect(failing.items(cfg, ctx)).rejects.toThrow(
      'Jira /rest/api/3/field: 401 You are not authorized',
    )
  })

  it('prefetches issue.md with fields and comments', async () => {
    const [eng12] = await items()
    const dir = await mkdtemp(join(tmpdir(), 'nightshift-'))
    await source.prefetch(eng12 as never, dir, ctx)
    const issue = await readFile(join(dir, 'issue.md'), 'utf8')
    expect(issue).toContain('# ENG-12: Refill the rate-limit bucket\n\n')
    expect(issue).toContain('- status: QA\n')
    expect(issue).toContain('- fields.Team: Platform\n')
    expect(issue).toContain('### QA, 2026-01-01T10:00:00.000Z\n\n@Dev still returns 500')
  })

  it('renders headings, links, quotes and ordered lists from ADF', () => {
    const doc: Adf = {
      type: 'doc',
      content: [
        { type: 'heading', attrs: { level: 2 }, content: [text('Steps')] },
        {
          type: 'orderedList',
          content: [
            { type: 'listItem', content: [para(text('one'))] },
            { type: 'listItem', content: [para(text('two'))] },
          ],
        },
        { type: 'blockquote', content: [para(text('quoted'))] },
        para(text('docs', [{ type: 'link', attrs: { href: 'https://x.test' } }])),
      ],
    }
    expect(adfToMarkdown(doc)).toBe(
      '## Steps\n\n1. one\n2. two\n\n> quoted\n\n[docs](https://x.test)',
    )
  })

  it('renders tasks, statuses, dates and tables from ADF', () => {
    const task = (state: string, t: string): Adf => ({
      type: 'taskItem',
      attrs: { state },
      content: [text(t)],
    })
    const row = (cell: string, ...texts: string[]): Adf => ({
      type: 'tableRow',
      content: texts.map((t) => ({ type: cell, content: [para(text(t))] })),
    })
    const doc: Adf = {
      type: 'doc',
      content: [
        { type: 'taskList', content: [task('DONE', 'first'), task('TODO', 'second')] },
        para(text('Blocked, '), { type: 'status', attrs: { text: 'IN REVIEW' } }, text(' since '), {
          type: 'date',
          attrs: { timestamp: '1767225600000' },
        }),
        {
          type: 'table',
          content: [row('tableHeader', 'Case', 'Result'), row('tableCell', 'a | b', 'ok')],
        },
      ],
    }
    expect(adfToMarkdown(doc)).toBe(
      '- [x] first\n- [ ] second\n\nBlocked, IN REVIEW since 2026-01-01\n\n| Case | Result |\n| --- | --- |\n| a \\| b | ok |',
    )
  })

  it('sets up a classic token on the site URL, without a cloud id', async () => {
    const http = jiraFetch()
    const ask = scriptedAsk([
      [/^Jira Cloud site/, 'acme.atlassian.net'],
      [/^Atlassian account email/, 'dev@acme.test'],
      [/^Is the token scoped/, false],
      [/^Jira projects/, ['ENG']],
      [/^GitHub repo for issues in ENG/, 'acme/api'],
    ])
    const setup = await jiraSource(http).init?.(ask, ctx)
    expect(setup?.config).toEqual({
      site: 'acme.atlassian.net',
      email: 'dev@acme.test',
      project_repos: { ENG: 'acme/api' },
    })
    expect(http.calls.map((c) => c.url.split('?')[0])).toEqual([
      'https://acme.atlassian.net/rest/api/3/project/search',
      'https://acme.atlassian.net/rest/api/3/status',
    ])
  })

  it('lists every page of projects at setup', async () => {
    const projects = JSON.parse(jiraFixture('projects.json'))
    const ops = { id: '10002', key: 'OPS', name: 'Operations' }
    const http = jiraFetch([
      [/\/project\/search\?startAt=0&/, JSON.stringify({ ...projects, isLast: false })],
      [
        /\/project\/search\?startAt=2&/,
        JSON.stringify({ ...projects, isLast: true, values: [ops] }),
      ],
    ])
    const ask = scriptedAsk([
      [/^Jira Cloud site/, 'acme.atlassian.net'],
      [/^Atlassian account email/, 'dev@acme.test'],
      [/^Is the token scoped/, true],
      [/^Jira projects/, []],
    ])
    const setup = await jiraSource(http).init?.(ask, ctx)
    expect(setup?.values?.project).toEqual(['ENG', 'WEB', 'OPS'])
  })

  it('refuses to set up without a site', async () => {
    const ask = scriptedAsk([
      [/^Jira Cloud site/, ''],
      [/^Atlassian account email/, ''],
    ])
    await expect(source.init?.(ask, ctx)).rejects.toThrow('Jira needs a site and an email')
  })

  it('takes a site host and projects mapped to owner/repo', () => {
    const configured = (site: string, repo: string) =>
      `providers: [claude]\nsources: { jira: { site: ${site}, email: a@b.c, project_repos: { ENG: ${repo} } } }`
    expect(() => parseConfig(configured('acme.atlassian.net', 'acme/api'))).not.toThrow()
    expect(() => parseConfig(configured('acme.atlassian.net', 'api'))).toThrow('project_repos')
    expect(() => parseConfig(configured('https://acme.atlassian.net', 'acme/api'))).toThrow('site')
  })
})
