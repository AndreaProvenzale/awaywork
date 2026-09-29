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
import { asanaRoutes, recordedFetch } from './fakes/asana.js'
import { initial, scriptedAsk } from './fakes/ask.js'
import { recorded } from './fakes/gh.js'
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
  sources: { github: githubSource(gh()), asana: asanaSource(recordedFetch(asanaRoutes())) },
  skills,
})

describe('init', () => {
  it('writes a valid config with the picked providers, sources and default queue', async () => {
    const ask = scriptedAsk([
      [/^Providers/, initial],
      [/^Where does the work come from/, initial],
      [/^GitHub repos to watch.*your orgs: acme, widgets/, 'octo/*, acme/api'],
      [/^Starting queue/, initial],
      [/^Night starts at/, '23:30'],
      [/^Night ends at/, initial],
    ])
    const text = await initConfig({ ask, installed: ['claude'], ghLogin: true, ...registry() })
    expect(text).toMatchInlineSnapshot(`
      "# night-shift config: \`nightshift config edit\` validates on save,
      # \`nightshift queue\` reorders the queue, \`nightshift plan\` previews tonight.
      night: { start: "23:30", end: "07:00" }
      budget:                         # every provider; override one with - <id>: { budget: … }
        reserve: 10%                  # never go past 1 - reserve of any window
        session_max: 90%              # stop a worker past this share of the short window
        # per_night: 15%              # at most this share of the long window per night
      providers: [claude]             # order = routing preference
      sources:
        github: {repos: [octo/*, acme/api]}
      queue:                          # first matching rule wins; top = highest priority
        - skill: fix-ci
          source: github
          where: {type: pr, mine: true, checks: failing}
        - skill: address-review
          source: github
          where: {type: pr, mine: true, unresolved_threads: {not: 0}}
        - skill: review
          source: github
          where: {type: pr, review_requested: true, trusted: true}
      "
    `)
    const cfg = parseConfig(text)
    expect(cfg.night).toEqual({ start: '23:30', end: '07:00' })
    expect(cfg.budget).toMatchObject({ reserve: 0.1, session_max: 0.9 })
    expect(cfg.budget.per_night).toBeUndefined()
  })

  it('orders providers by the one picked first', async () => {
    const ask = scriptedAsk([
      [/^Providers/, ['claude', 'codex']],
      [/^Which provider takes units first/, 'codex'],
      [/^Where does the work come from/, ['github']],
      [/^GitHub repos/, initial],
      [/^Starting queue/, []],
      [/^Night starts/, initial],
      [/^Night ends/, initial],
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
      [/^Which section holds the items for qa-feedback\? Fix the issues QA/, initial],
      [/^Which section holds the items for continue/, 'Doing'],
      [/^Which section holds the items for plan/, ''],
      [/^Night starts/, initial],
      [/^Night ends/, initial],
    ])
    const text = await initConfig({ ask, installed: ['claude'], ghLogin: false, ...registry() })
    const cfg = parseConfig(text)
    expect(cfg.sources).toEqual({
      asana: {
        workspace: '100',
        projects: ['300'],
        project_repos: { '300': 'acme/api' },
        token_env: 'ASANA_TOKEN',
      },
    })
    expect(cfg.queue?.map((r) => [r.skill, r.where])).toEqual([
      ['qa-feedback', { section: 'QA' }],
      ['continue', { section: 'Doing' }],
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
      [/^Night starts/, initial],
      [/^Night ends/, initial],
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
      [/^Night starts/, initial],
      [/^Night ends/, initial],
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
      [/^Night starts/, '25:00'],
      [/^Night starts at \(HH:MM/, '02:00'],
      [/^Night ends/, initial],
    ])
    const setup = registry()
    setup.sources.github = githubSource(recorded([]))
    const text = await initConfig({ ask, installed: ['claude'], ghLogin: false, ...setup })
    expect(ask.notes).toEqual([expect.stringMatching(/^Skipping github: no recorded output/)])
    expect(parseConfig(text).night.start).toBe('02:00')
  })
})

describe('init --yes', () => {
  it('takes the installed providers, github when gh is logged in and the default queue', async () => {
    const ask = defaultAsk([], () => {})
    const text = await initConfig({ ask, installed: ['codex'], ghLogin: true, ...registry() })
    const cfg = parseConfig(text)
    expect(cfg.providers.map((p) => p.id)).toEqual(['codex'])
    expect(cfg.sources).toEqual({ github: { repos: ['octo/*'] } })
    expect(cfg.queue?.map((r) => r.skill)).toEqual(['fix-ci', 'address-review', 'review'])
    expect(cfg.night).toEqual({ start: '01:00', end: '07:00' })
  })

  it('answers from the presets and skips a source whose secret is unset', async () => {
    const notes: string[] = []
    const ask = defaultAsk(
      [
        [/^Providers/, ['codex', 'claude']],
        [/^Where does the work come from/, ['asana', 'github']],
        [/^Night starts/, '22:00'],
        [/^Night ends/, '06:00'],
      ],
      (note) => void notes.push(note),
    )
    const text = await initConfig({ ask, installed: [], ghLogin: false, ...registry({}) })
    const cfg = parseConfig(text)
    expect(cfg.providers.map((p) => p.id)).toEqual(['codex', 'claude'])
    expect(Object.keys(cfg.sources)).toEqual(['github'])
    expect(cfg.night).toEqual({ start: '22:00', end: '06:00' })
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
    const file = join(await mkdtemp(join(tmpdir(), 'nightshift-env-')), 'env')
    await saveSecret('A', '1', file)
    expect((await stat(file)).mode & 0o777).toBe(0o600)
    await writeFile(file, 'A=1\nB=2')
    await saveSecret('C', '3', file)
    expect(await readFile(file, 'utf8')).toBe('A=1\nB=2\nC=3\n')
  })
})
