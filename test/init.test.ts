import { mkdtemp, readFile, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { Cancelled, defaultAsk, saveSecret } from '../src/cli/ask.js'
import { initConfig } from '../src/cli/init.js'
import { parseConfig } from '../src/config/load.js'
import { builtinSkillsDir } from '../src/config/paths.js'
import { loadSkills } from '../src/config/skills.js'
import type { Ctx } from '../src/core/types.js'
import { asanaSource } from '../src/sources/asana.js'
import { githubSource } from '../src/sources/github.js'
import { jiraSource } from '../src/sources/jira.js'
import { linearSource } from '../src/sources/linear.js'
import { asanaRoutes, recordedFetch } from './fakes/asana.js'
import { initial, scriptedAsk } from './fakes/ask.js'
import { recorded } from './fakes/gh.js'
import { jiraFetch } from './fakes/jira.js'
import { linearFetch } from './fakes/linear.js'
import { fakeProvider } from './fakes/provider.js'

const skills = await loadSkills(builtinSkillsDir)
const gh = () =>
  recorded([
    [/^gh api user --jq/, 'octo\n'],
    [/^gh api user\/orgs/, 'acme\nwidgets\n'],
  ])
const registry = (env: Ctx['env'] = { ASANA_TOKEN: 'pat' }) => ({
  ctx: { env, log: () => {} },
  providers: { claude: fakeProvider('claude'), codex: fakeProvider('codex') },
  sources: {
    github: githubSource(gh()),
    asana: asanaSource(recordedFetch(asanaRoutes())),
    linear: linearSource(linearFetch()),
    jira: jiraSource(jiraFetch()),
  },
  skills,
})

describe('init', () => {
  it('writes a valid config with the picked providers, sources and default queue', async () => {
    const ask = scriptedAsk([
      [/^Providers/, initial],
      [/^Where does the work come from/, initial],
      [/^GitHub repos to watch.*your orgs: acme, widgets/, 'octo/*, acme/api'],
      [/^Starting queue/, initial],
      [/^Window starts at/, '23:30'],
      [/^Window ends at/, initial],
    ])
    const text = await initConfig({ ask, installed: ['claude'], ghLogin: true, ...registry() })
    expect(text).toMatchInlineSnapshot(`
      "# awaywork config: \`awaywork config edit\` validates on save,
      # \`awaywork plan\` previews the next run, \`awaywork plan --rules\` what each rule takes.
      windows: [{ start: "23:30", end: "07:00" }]
      budget:                         # every provider; override one with - <id>: { budget: … }
        reserve: 10%                  # never go past 1 - reserve of any window
        session_max: 90%              # stop a worker past this share of the short window
        # per_run: 15%                # at most this share of the long window per run
      providers: [claude]             # order = routing preference
      sources:
        github: {repos: [octo/*, acme/api]}
      queue:                          # first matching rule wins; top = highest priority
        - skill: fix
          source: github
          where: {type: pr, mine: true, checks: failing}
        - skill: fix
          source: github
          where: {type: pr, mine: true, unresolved_threads: {not: 0}}
        - skill: fix
          source: github
          where: {type: pr, mine: true, ours: true, my_unresolved_threads: {not: 0}}
        - skill: review
          source: github
          where: {type: pr, review_requested: true, trusted: true}
      "
    `)
    const cfg = parseConfig(text)
    expect(cfg.windows).toEqual([{ start: '23:30', end: '07:00' }])
    expect(cfg.budget).toMatchObject({ reserve: 0.1, session_max: 0.9 })
    expect(cfg.budget.per_run).toBeUndefined()
  })

  it('orders providers by the one picked first', async () => {
    const ask = scriptedAsk([
      [/^Providers/, ['claude', 'codex']],
      [/^Which provider takes units first/, 'codex'],
      [/^Where does the work come from/, ['github']],
      [/^GitHub repos/, initial],
      [/^Starting queue/, []],
      [/^Window starts/, initial],
      [/^Window ends/, initial],
    ])
    const text = await initConfig({ ask, installed: [], ghLogin: true, ...registry() })
    const cfg = parseConfig(text)
    expect(cfg.providers.map((p) => p.id)).toEqual(['codex', 'claude'])
    expect(cfg.sources).toEqual({ github: { repos: ['octo/*'] } })
    expect(cfg.queue).toEqual([])
  })

  it("maps Asana rules onto the project's real sections", async () => {
    const ask = scriptedAsk([
      [/^Providers/, initial],
      [/^Where does the work come from/, ['asana']],
      [/^Asana workspace/, '100'],
      [/^Asana projects/, ['300']],
      [/^GitHub repo for tasks in Platform/, 'acme/api'],
      [/^Starting queue/, initial],
      [/^Which section holds the items for fix\? Fix the problems/, initial],
      [/^Which section holds the items for implement/, 'Doing'],
      [/^Which section holds the items for plan/, ''],
      [/^Window starts/, initial],
      [/^Window ends/, initial],
    ])
    const text = await initConfig({ ask, installed: ['claude'], ghLogin: false, ...registry() })
    const cfg = parseConfig(text)
    expect(cfg.sources).toEqual({
      asana: {
        workspace: '100',
        projects: ['300'],
        repo_map: { '300': 'acme/api' },
        token_env: 'ASANA_TOKEN',
      },
    })
    expect(cfg.queue?.map((r) => [r.skill, r.where])).toEqual([
      ['fix', { section: 'QA' }],
      ['implement', { section: 'Doing' }],
    ])
  })

  it("maps Linear teams to repos and rules onto the teams' real states", async () => {
    const ask = scriptedAsk([
      [/^Providers/, initial],
      [/^Where does the work come from/, ['linear']],
      [/^Linear teams/, ['ENG', 'WEB']],
      [/^GitHub repo for issues in ENG/, 'acme/api'],
      [/^GitHub repo for issues in WEB/, ''],
      [/^Starting queue/, initial],
      [/^Which status holds the items for fix/, initial],
      [/^Which status holds the items for implement/, initial],
      [/^Which status holds the items for plan/, ''],
      [/^Window starts/, initial],
      [/^Window ends/, initial],
    ])
    const env = { LINEAR_API_KEY: 'lin_api_key' }
    const text = await initConfig({ ask, installed: ['claude'], ghLogin: false, ...registry(env) })
    const cfg = parseConfig(text)
    expect(cfg.sources).toEqual({
      linear: { repo_map: { ENG: 'acme/api' }, token_env: 'LINEAR_API_KEY' },
    })
    expect(cfg.queue?.map((r) => [r.skill, r.where])).toEqual([
      ['fix', { status: 'QA' }],
      ['implement', { status: 'In Progress' }],
    ])
  })

  it("maps Jira projects to repos through the gateway and rules onto the site's statuses", async () => {
    const ask = scriptedAsk([
      [/^Providers/, initial],
      [/^Where does the work come from/, ['jira']],
      [/^Jira Cloud site/, 'acme.atlassian.net'],
      [/^Atlassian account email/, 'dev@acme.test'],
      [/^Atlassian API token/, 'atl-token'],
      [/^Is the token scoped/, true],
      [/^Jira projects/, ['ENG', 'WEB']],
      [/^GitHub repo for issues in ENG/, 'acme/api'],
      [/^GitHub repo for issues in WEB/, ''],
      [/^Starting queue/, initial],
      [/^Which status holds the items for fix/, initial],
      [/^Which status holds the items for implement/, initial],
      [/^Which status holds the items for plan/, initial],
      [/^Window starts/, initial],
      [/^Window ends/, initial],
    ])
    const text = await initConfig({ ask, installed: ['claude'], ghLogin: false, ...registry({}) })
    expect(ask.secrets).toEqual(['JIRA_API_TOKEN'])
    const cfg = parseConfig(text)
    expect(cfg.sources).toEqual({
      jira: {
        site: 'acme.atlassian.net',
        email: 'dev@acme.test',
        cloud_id: '0a1b2c3d-0000-4000-8000-000000000001',
        repo_map: { ENG: 'acme/api' },
        token_env: 'JIRA_API_TOKEN',
      },
    })
    expect(cfg.queue?.map((r) => [r.skill, r.where])).toEqual([
      ['fix', { status: 'QA' }],
      ['implement', { status: 'In Progress' }],
      ['plan', { status: 'To Do' }],
    ])
  })

  it("reads sections from the user's tasks when no project is picked", async () => {
    const ask = scriptedAsk([
      [/^Providers/, initial],
      [/^Where does the work come from/, ['asana']],
      [/^Asana workspace/, '100'],
      [/^Asana projects/, []],
      [/^Starting queue/, ['2']],
      [/^Which section holds the items for plan/, initial],
      [/^Window starts/, initial],
      [/^Window ends/, initial],
    ])
    const text = await initConfig({ ask, installed: ['claude'], ghLogin: false, ...registry() })
    expect(parseConfig(text).queue?.map((r) => r.where)).toEqual([{ section: 'Current sprint' }])
  })

  it('asks for a missing Asana token, or the workspace gid without one', async () => {
    const ask = scriptedAsk([
      [/^Providers/, initial],
      [/^Where does the work come from/, ['asana']],
      [/^Asana personal access token/, ''],
      [/^Asana workspace gid/, '100'],
      [/^Starting queue/, initial],
      [/^Window starts/, initial],
      [/^Window ends/, initial],
    ])
    const text = await initConfig({ ask, installed: ['claude'], ghLogin: false, ...registry({}) })
    expect(ask.secrets).toEqual(['ASANA_TOKEN'])
    expect(parseConfig(text).queue?.map((r) => r.where.section)).toEqual([
      'QA',
      'In progress',
      'Current sprint',
    ])
  })

  it('skips a source whose setup fails and asks again when none is left', async () => {
    const ask = scriptedAsk([
      [/^Providers/, []],
      [/^Providers/, initial],
      [/^Where does the work come from/, ['github']],
      [/^Where does the work come from/, ['asana']],
      [/^Asana workspace/, '100'],
      [/^Asana projects/, []],
      [/^Starting queue/, []],
      [/^Window starts/, '25:00'],
      [/^Window starts at \(HH:MM/, '02:00'],
      [/^Window ends/, initial],
    ])
    const setup = registry()
    setup.sources.github = githubSource(recorded([]))
    const text = await initConfig({ ask, installed: ['claude'], ghLogin: false, ...setup })
    expect(ask.notes).toEqual([expect.stringMatching(/^Skipping github: no recorded output/)])
    expect(parseConfig(text).windows[0]?.start).toBe('02:00')
  })
})

describe('init --yes', () => {
  it('takes the installed providers, github when gh is logged in and the default queue', async () => {
    const ask = defaultAsk([], () => {})
    const text = await initConfig({ ask, installed: ['codex'], ghLogin: true, ...registry() })
    const cfg = parseConfig(text)
    expect(cfg.providers.map((p) => p.id)).toEqual(['codex'])
    expect(cfg.sources).toEqual({ github: { repos: ['octo/*'] } })
    expect(cfg.queue?.map((r) => r.skill)).toEqual(['fix', 'fix', 'fix', 'review'])
    expect(cfg.windows).toEqual([{ start: '01:00', end: '07:00' }])
  })

  it('answers from the presets and skips a source whose secret is unset', async () => {
    const notes: string[] = []
    const ask = defaultAsk(
      [
        [/^Providers/, ['codex', 'claude']],
        [/^Where does the work come from/, ['asana', 'github']],
        [/^Window starts/, '22:00'],
        [/^Window ends/, '06:00'],
      ],
      (note) => void notes.push(note),
    )
    const text = await initConfig({ ask, installed: [], ghLogin: false, ...registry({}) })
    const cfg = parseConfig(text)
    expect(cfg.providers.map((p) => p.id)).toEqual(['codex', 'claude'])
    expect(Object.keys(cfg.sources)).toEqual(['github'])
    expect(cfg.windows).toEqual([{ start: '22:00', end: '06:00' }])
    expect(notes).toEqual(['Skipping asana: ASANA_TOKEN is not set'])
  })

  it('fails instead of asking again when a default is not enough', async () => {
    const ask = defaultAsk([], () => {})
    await expect(initConfig({ ask, installed: [], ghLogin: true, ...registry() })).rejects.toThrow(
      new Cancelled('no default for "Providers (pick at least one)"'),
    )
  })
})

describe('saveSecret', () => {
  it('appends on its own line to a file created with mode 600', async () => {
    const file = join(await mkdtemp(join(tmpdir(), 'awaywork-env-')), 'env')
    await saveSecret('A', '1', file)
    expect((await stat(file)).mode & 0o777).toBe(0o600)
    await writeFile(file, 'A=1\nB=2')
    await saveSecret('C', '3', file)
    expect(await readFile(file, 'utf8')).toBe('A=1\nB=2\nC=3\n')
  })
})
