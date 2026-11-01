import { afterEach, describe, expect, it, vi } from 'vitest'
import { discoverSources, formatDiscoveries } from '../src/cli/sources.js'
import { parseConfig } from '../src/config/load.js'
import { envFile } from '../src/config/paths.js'
import type { Ctx } from '../src/core/types.js'
import { asanaSource } from '../src/sources/asana.js'
import { bitbucket } from '../src/sources/bitbucket.js'
import { githubSource } from '../src/sources/github.js'
import { jiraSource } from '../src/sources/jira.js'
import { linearSource } from '../src/sources/linear.js'
import { asanaRoutes, recordedFetch } from './fakes/asana.js'
import { recorded } from './fakes/gh.js'
import { jiraFetch } from './fakes/jira.js'
import { linearFetch } from './fakes/linear.js'

const env = { ASANA_TOKEN: 'pat', LINEAR_API_KEY: 'lin_api_key', JIRA_API_TOKEN: 'atl-token' }
const ctx = { env, log: () => {} }
const jira = { site: 'acme.atlassian.net', email: 'dev@acme.test', token_env: 'JIRA_API_TOKEN' }

function registry() {
  const gh = recorded([
    [/^gh api user --jq/, 'octo\n'],
    [/^gh api user\/orgs/, 'acme\nwidgets\n'],
  ])
  const asanaHttp = recordedFetch(asanaRoutes())
  const jiraHttp = jiraFetch()
  return {
    gh,
    asanaHttp,
    jiraHttp,
    sources: {
      github: githubSource(gh),
      bitbucket,
      asana: asanaSource(asanaHttp),
      linear: linearSource(linearFetch()),
      jira: jiraSource(jiraHttp),
    },
  }
}

const discover = (
  id: string | undefined,
  configured: Record<string, unknown>,
  e: Ctx['env'] = env,
) => discoverSources(id, configured, { ...ctx, env: e }, registry().sources)

describe('awaywork sources', () => {
  afterEach(() => {
    process.exitCode = undefined
    vi.restoreAllMocks()
  })

  it("lists the gh login and its orgs, on the config's host", async () => {
    const r = registry()
    const configured = { github: { repos: ['acme/*'], host: 'github.acme.com' } }
    const { found } = await discoverSources('github', configured, ctx, r.sources)
    expect(found).toEqual([
      { id: 'github', discovery: { login: 'octo', orgs: ['acme', 'widgets'] } },
    ])
    expect(r.gh.calls).toEqual([
      ['gh', 'api', 'user', '--jq', '.login'],
      ['gh', 'api', 'user/orgs', '--jq', '.[].login'],
    ])
  })

  it("lists every Asana workspace's projects and my tasks' sections when Asana isn't configured", async () => {
    const {
      found: [found],
    } = await discover('asana', {})
    const projects = [
      { gid: '300', name: 'Platform' },
      { gid: '301', name: 'Mobile' },
    ]
    const sections = ['QA', 'In progress', 'Current sprint', 'Q3']
    expect(found?.discovery).toEqual({
      workspaces: [
        { gid: '100', name: 'Acme', projects, sections },
        { gid: '200', name: 'Personal', projects, sections },
      ],
    })
  })

  it("lists only the configured workspace's projects, and its projects' sections", async () => {
    const configured = { asana: { workspace: '100', projects: ['300'], token_env: 'ASANA_TOKEN' } }
    const {
      found: [found],
    } = await discover('asana', configured)
    expect(found?.discovery).toEqual({
      workspaces: [
        {
          gid: '100',
          name: 'Acme',
          projects: [
            { gid: '300', name: 'Platform' },
            { gid: '301', name: 'Mobile' },
          ],
          sections: ['Backlog', 'Sprint', 'Doing', 'QA'],
        },
        { gid: '200', name: 'Personal' },
      ],
    })
  })

  it('lists Linear teams with their workflow states', async () => {
    const {
      found: [found],
    } = await discover('linear', {})
    expect(found?.discovery).toEqual({
      teams: [
        { key: 'ENG', name: 'Engineering', states: ['Todo', 'In Progress', 'QA', 'Done'] },
        { key: 'WEB', name: 'Web', states: ['Todo', 'In Progress', 'Done'] },
      ],
    })
  })

  it("lists Jira projects and the site's statuses, through the gateway with a cloud id", async () => {
    const r = registry()
    const configured = { jira: { ...jira, cloud_id: 'cloud-1' } }
    const {
      found: [found],
    } = await discoverSources('jira', configured, ctx, r.sources)
    expect(found?.discovery).toEqual({
      projects: [
        { key: 'ENG', name: 'Engineering' },
        { key: 'WEB', name: 'Web' },
      ],
      statuses: ['To Do', 'In Progress', 'QA', 'Done'],
    })
    expect(r.jiraHttp.calls.map((c) => c.url.split('?')[0])).toEqual([
      'https://api.atlassian.com/ex/jira/cloud-1/rest/api/3/myself',
      'https://api.atlassian.com/ex/jira/cloud-1/rest/api/3/project/search',
      'https://api.atlassian.com/ex/jira/cloud-1/rest/api/3/status',
    ])
  })

  it('fails on credentials Jira takes for anonymous, rather than listing what anonymous sees', async () => {
    const anonymous = jiraFetch([
      [/\/rest\/api\/3\/myself$/, { status: 401, body: '{}' }],
      [/\/rest\/api\/3\/project\/search/, '{ "values": [], "isLast": true }'],
      [/\/rest\/api\/3\/status$/, '[]'],
    ])
    const result = await discoverSources('jira', { jira }, ctx, { jira: jiraSource(anonymous) })
    expect(result.found).toEqual([])
    expect(result.failed).toEqual([
      expect.stringMatching(/^jira: Jira \/rest\/api\/3\/myself: 401/),
    ])
    expect(anonymous.calls.map((c) => c.url)).toEqual([
      'https://acme.atlassian.net/rest/api/3/myself',
    ])
  })

  it('asks for Jira in the config first: its site and email come from there alone', async () => {
    expect((await discover('jira', {}, {})).failed).toEqual([
      'jira: add sources.jira { site, email } to the config first',
    ])
  })

  it('names an unset token and the env file to save it in', async () => {
    expect((await discover('linear', {}, {})).failed).toEqual([
      `linear: LINEAR_API_KEY is not set; export it, or add it to ${envFile} (mode 600)`,
    ])
    expect((await discover('jira', { jira: { ...jira, token_env: 'ACME_JIRA' } })).failed).toEqual([
      `jira: ACME_JIRA is not set; export it, or add it to ${envFile} (mode 600)`,
    ])
  })

  it('reads every configured source that can tell, skipping the rest', async () => {
    const { sources } = parseConfig(`providers: [claude]
sources:
  linear: { every: 1h, link: 'Fixes {key}' }
  bitbucket: { repos: [acme/api] }
  jira: { site: acme.atlassian.net, email: dev@acme.test, context: { command: 'echo {}' } }
  chores: { command: 'echo []' }
`)
    const { found } = await discover(undefined, sources)
    expect(found.map((f) => f.id)).toEqual(['linear', 'jira'])
  })

  it('lists the sources that can tell when another fails, and fails the command naming it', async () => {
    const configured = { linear: {}, asana: { workspace: '200', token_env: 'ASANA_TOKEN' } }
    const result = await discover(undefined, configured, { ASANA_TOKEN: 'pat' })
    expect(result.found.map((f) => f.id)).toEqual(['asana'])
    const stderr = vi.spyOn(console, 'error').mockImplementation(() => {})
    expect(JSON.parse(formatDiscoveries(result, true))).toEqual({
      asana: result.found[0]?.discovery,
    })
    expect(stderr).toHaveBeenCalledWith(
      `linear: LINEAR_API_KEY is not set; export it, or add it to ${envFile} (mode 600)`,
    )
    expect(process.exitCode).toBe(1)
  })

  it('fails with every reason when no source could tell', () => {
    expect(() => formatDiscoveries({ found: [], failed: ['linear: no', 'jira: nope'] })).toThrow(
      'linear: no\njira: nope',
    )
  })

  it("says so of a source with nothing to discover, or one that doesn't exist", async () => {
    await expect(discover('bitbucket', {})).rejects.toThrow('bitbucket has nothing to discover')
    await expect(discover('trello', {})).rejects.toThrow('no source "trello"')
  })

  it('prints what each source can see as YAML, never a token', async () => {
    const result = await discover(undefined, {
      linear: { token_env: 'LINEAR_API_KEY' },
      asana: { workspace: '200', token_env: 'ASANA_TOKEN' },
    })
    expect(formatDiscoveries(result)).toBe(
      [
        'linear:',
        '  teams:',
        '    - key: ENG',
        '      name: Engineering',
        '      states:',
        '        - Todo',
        '        - In Progress',
        '        - QA',
        '        - Done',
        '    - key: WEB',
        '      name: Web',
        '      states:',
        '        - Todo',
        '        - In Progress',
        '        - Done',
        'asana:',
        '  workspaces:',
        '    - gid: "100"',
        '      name: Acme',
        '    - gid: "200"',
        '      name: Personal',
        '      projects:',
        '        - gid: "300"',
        '          name: Platform',
        '        - gid: "301"',
        '          name: Mobile',
        '      sections:',
        '        - QA',
        '        - In progress',
        '        - Current sprint',
        '        - Q3',
      ].join('\n'),
    )
    expect(formatDiscoveries(result)).not.toContain('lin_api_key')
  })

  it('says when nothing could tell', () => {
    expect(formatDiscoveries({ found: [], failed: [] })).toBe(
      'No configured source has anything to discover',
    )
  })
})
