import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { discoverSources, formatDiscovered } from '../src/cli/sources.js'
import { parseConfig } from '../src/config/load.js'
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
const noFile = join(tmpdir(), 'awaywork-no-env-file')

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
) => {
  const r = registry()
  return discoverSources(id, configured, { ...ctx, env: e }, r.sources, noFile)
}

describe('awaywork sources', () => {
  it("lists the gh login and its orgs, on the config's host", async () => {
    const r = registry()
    const configured = { github: { repos: ['acme/*'], host: 'github.acme.com' } }
    const [found] = await discoverSources('github', configured, ctx, r.sources, noFile)
    expect(found).toEqual({
      id: 'github',
      credentials: [],
      discovery: { login: 'octo', orgs: ['acme', 'widgets'] },
    })
    expect(r.gh.calls).toEqual([
      ['gh', 'api', 'user', '--jq', '.login'],
      ['gh', 'api', 'user/orgs', '--jq', '.[].login'],
    ])
  })

  it("lists every Asana workspace's projects and my tasks' sections when Asana isn't configured", async () => {
    const [found] = await discover('asana', {})
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
    const [found] = await discover('asana', configured)
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
    const [found] = await discover('linear', {})
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
    const [found] = await discoverSources('jira', configured, ctx, r.sources, noFile)
    expect(found?.discovery).toEqual({
      projects: [
        { key: 'ENG', name: 'Engineering' },
        { key: 'WEB', name: 'Web' },
      ],
      statuses: ['To Do', 'In Progress', 'QA', 'Done'],
    })
    expect(r.jiraHttp.calls.map((c) => c.url.split('?')[0])).toEqual([
      'https://api.atlassian.com/ex/jira/cloud-1/rest/api/3/project/search',
      'https://api.atlassian.com/ex/jira/cloud-1/rest/api/3/status',
    ])
  })

  it('asks for Jira in the config first: its site and email come from there alone', async () => {
    await expect(discover('jira', {}, {})).rejects.toThrow(
      'jira: add sources.jira { site, email } to the config first',
    )
  })

  it('names an unset token and the env file to save it in', async () => {
    await expect(discover('linear', {}, {})).rejects.toThrow(
      `linear: LINEAR_API_KEY is not set; export it, or add it to ${noFile} (mode 600)`,
    )
    await expect(
      discover('jira', { jira: { ...jira, token_env: 'ACME_JIRA' } }, env),
    ).rejects.toThrow('jira: ACME_JIRA is not set')
  })

  it('reads every configured source that can tell, skipping the rest', async () => {
    const { sources } = parseConfig(`providers: [claude]
sources:
  linear: {}
  bitbucket: { repos: [acme/api] }
  jira: { site: acme.atlassian.net, email: dev@acme.test }
  chores: { command: 'echo []' }
`)
    const found = await discover(undefined, sources)
    expect(found.map((f) => f.id)).toEqual(['linear', 'jira'])
  })

  it("says so of a source with nothing to discover, or one that doesn't exist", async () => {
    await expect(discover('bitbucket', {})).rejects.toThrow('bitbucket has nothing to discover')
    await expect(discover('trello', {})).rejects.toThrow('no source "trello"')
  })

  it('says where each token came from, never its value', async () => {
    const file = join(await mkdtemp(join(tmpdir(), 'awaywork-env-')), 'env')
    await writeFile(file, 'LINEAR_API_KEY=lin_api_key\n')
    const r = registry()
    const found = await discoverSources(
      undefined,
      {
        linear: { token_env: 'LINEAR_API_KEY' },
        asana: { workspace: '200', token_env: 'ASANA_TOKEN' },
      },
      ctx,
      r.sources,
      file,
    )
    expect(found.map((f) => f.credentials)).toEqual([
      [`LINEAR_API_KEY from ${file}`],
      ['ASANA_TOKEN from the environment'],
    ])
    expect(formatDiscovered(found)).toBe(
      [
        `linear  (LINEAR_API_KEY from ${file})`,
        '  teams',
        '    ENG  Engineering  states: Todo, In Progress, QA, Done',
        '    WEB  Web          states: Todo, In Progress, Done',
        '',
        'asana  (ASANA_TOKEN from the environment)',
        '  workspaces',
        '    100  Acme',
        '    200  Personal  sections: QA, In progress, Current sprint, Q3',
        '      projects',
        '        300  Platform',
        '        301  Mobile',
      ].join('\n'),
    )
    expect(formatDiscovered(found)).not.toContain('lin_api_key')
  })

  it('prints a source without secrets by its id alone, and says when nothing could tell', async () => {
    expect(formatDiscovered(await discover('github', {}))).toBe(
      'github\n  login: octo\n  orgs: acme, widgets',
    )
    expect(formatDiscovered([])).toBe('No configured source has anything to discover')
  })
})
