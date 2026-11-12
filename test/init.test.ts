import { chmod, mkdtemp, readFile, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { saveSecret } from '../src/cli/ask.js'
import { type InitInput, initConfig, NothingToWrite } from '../src/cli/init.js'
import { parseConfig } from '../src/config/load.js'
import type { Ctx, Discovery, Source } from '../src/core/types.js'
import { asanaSource } from '../src/sources/asana.js'
import { githubSource } from '../src/sources/github.js'
import { jiraSource } from '../src/sources/jira.js'
import { linearSource } from '../src/sources/linear.js'
import { routines } from '../src/sources/routines.js'
import { asanaRoutes, recordedFetch } from './fakes/asana.js'
import { recorded } from './fakes/gh.js'
import { jiraFetch } from './fakes/jira.js'
import { linearFetch } from './fakes/linear.js'
import { fakeProvider } from './fakes/provider.js'

const keys = { ASANA_TOKEN: 'pat', LINEAR_API_KEY: 'lin_api_key', JIRA_API_TOKEN: 'atl-token' }
const sources = {
  github: githubSource(
    recorded([
      [/^gh api user --jq/, 'octo\n'],
      [/^gh api user\/orgs/, 'acme\nwidgets\n'],
    ]),
  ),
  asana: asanaSource(recordedFetch(asanaRoutes())),
  linear: linearSource(linearFetch()),
  jira: jiraSource(jiraFetch()),
  routines,
}
const stub = (id: string, discover: () => Promise<Discovery>) =>
  ({
    id,
    configSchema: z.object({}),
    fields: {},
    secrets: () => [],
    items: async () => [],
    prefetch: async () => {},
    discover,
  }) as Source

/** The --yes config for these inputs, with the notes it printed. */
async function init(input: Partial<InitInput> & { env?: Ctx['env'] } = {}) {
  const notes: string[] = []
  const text = await initConfig({
    ctx: { env: input.env ?? keys, log: () => {} },
    installed: ['claude'],
    ghLogin: true,
    providers: { claude: fakeProvider('claude'), codex: fakeProvider('codex') },
    note: (note) => void notes.push(note),
    ...input,
    sources: { ...sources, ...input.sources },
  })
  return { text, cfg: parseConfig(text), notes }
}

describe('init --yes', () => {
  it('takes the installed providers, github as <login>/* when gh is logged in, its default rules and 01:00-07:00', async () => {
    const { text, notes } = await init()
    expect(notes).toEqual([])
    expect(text).toMatchInlineSnapshot(`
      "# awaywork config: \`awaywork config edit\` validates on save,
      # \`awaywork plan\` previews the next run, \`awaywork plan --rules\` what each rule takes.
      windows: [{ start: "01:00", end: "07:00" }]
      budget:                         # every provider; override one with - <id>: { budget: … }
        reserve: 10%                  # never go past 1 - reserve of any window
        session_max: 90%              # stop a worker past this share of the short window
        present_session_max: 40%      # the same, in a run outside every window
        # per_run: 15%                # at most this share of the long window per run
      providers: [claude]             # order = routing preference
      repos:                          # the only repos awaywork works in; a key takes settings
        octo/*:
      sources:
        github: {}
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
  })

  it('takes the providers in the order given, the sources and the window from the flags', async () => {
    const { cfg } = await init({
      installed: [],
      ghLogin: false,
      provider: ['codex', 'claude'],
      source: ['github', 'routines'],
      window: ['22:00', '06:00'],
    })
    expect(cfg.providers.map((p) => p.id)).toEqual(['codex', 'claude'])
    expect(cfg.repos).toEqual({ 'octo/*': { secrets: [], gates: {} } })
    expect(Object.keys(cfg.sources)).toEqual(['github', 'routines'])
    expect(cfg.windows).toEqual([{ start: '22:00', end: '06:00' }])
  })

  it('takes an installed Cursor only with CURSOR_API_KEY set, else says it needs one', async () => {
    const providers = { claude: fakeProvider('claude'), cursor: fakeProvider('cursor') }
    const picked = async (env: Ctx['env']) =>
      (await init({ env, installed: ['claude', 'cursor'], providers })).cfg.providers.map(
        (p) => p.id,
      )
    expect(await picked({})).toEqual(['claude'])
    expect(await picked({ CURSOR_API_KEY: 'key' })).toEqual(['claude', 'cursor'])
    await expect(init({ env: {}, installed: ['cursor'], providers })).rejects.toThrow(
      new NothingToWrite(
        'no provider found: install Claude Code, or set CURSOR_API_KEY for Cursor, or pass --provider',
      ),
    )
  })

  it("takes the first Asana workspace and its real section names, dropping the rule there's none for", async () => {
    const { cfg } = await init({ source: ['asana'] })
    expect(cfg.sources).toEqual({ asana: { workspace: '100', token_env: 'ASANA_TOKEN' } })
    expect(cfg.queue?.map((r) => [r.skill, r.where])).toEqual([
      ['fix', { section: 'QA' }],
      ['implement', { section: 'In progress' }],
      ['plan', { section: 'Current sprint' }],
    ])
    const asana = stub('asana', async () => ({
      workspaces: [{ gid: '100', name: 'Acme', sections: ['qa', 'Doing'] }],
    }))
    const renamed = await init({ source: ['asana'], sources: { asana } })
    expect(renamed.cfg.queue?.map((r) => r.where)).toEqual([{ section: 'qa' }])
  })

  it("maps Linear rules onto its teams' states and keeps a guess when nothing tells", async () => {
    const { cfg } = await init({ source: ['linear'] })
    expect(cfg.sources).toEqual({ linear: { token_env: 'LINEAR_API_KEY' } })
    expect(cfg.queue?.map((r) => [r.skill, r.where])).toEqual([
      ['fix', { status: 'QA' }],
      ['implement', { status: 'In Progress' }],
      ['plan', { status: 'Todo' }],
    ])
    const linear = stub('linear', async () => ({ teams: [] }))
    const guessed = await init({ source: ['linear'], sources: { linear } })
    expect(guessed.cfg.queue?.map((r) => r.where.status)).toEqual(['QA', 'In Progress', 'Todo'])
  })

  it('skips a source it cannot set up, naming an unset token and how to save it', async () => {
    const asana = stub('asana', async () => ({ workspaces: [] }))
    const { cfg, notes } = await init({
      env: {},
      source: ['jira', 'linear', 'asana', 'github'],
      sources: { asana },
    })
    expect(Object.keys(cfg.sources)).toEqual(['github'])
    expect(notes).toEqual([
      'Skipping jira: add sources.jira { site, email } to the config first',
      'Skipping linear: LINEAR_API_KEY is not set; awaywork secret LINEAR_API_KEY saves it',
      'Skipping asana: this token sees no workspace',
    ])
  })

  it('fails when no source is left, naming a missing gh login', async () => {
    await expect(init({ env: {}, source: ['asana'] })).rejects.toThrow(
      new NothingToWrite('no source could be set up'),
    )
    await expect(init({ ghLogin: false })).rejects.toThrow(
      new NothingToWrite('no source found: log in to gh (gh auth login), or pass --source'),
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

  it('replaces a name already in the file, and closes a file left open to others', async () => {
    const file = join(await mkdtemp(join(tmpdir(), 'awaywork-env-')), 'env')
    await writeFile(file, 'A=1\nB=2\nAB=3\n')
    await chmod(file, 0o644)
    await saveSecret('A', 'new', file)
    expect(await readFile(file, 'utf8')).toBe('B=2\nAB=3\nA=new\n')
    expect((await stat(file)).mode & 0o777).toBe(0o600)
  })

  it('drops the export and spaced forms of the name too, keeping every other line as it was', async () => {
    const file = join(await mkdtemp(join(tmpdir(), 'awaywork-env-')), 'env')
    const others = '# A=comment\n  B = 2\r\nexport AB=3\n\t\n'
    await writeFile(file, `export A=1\n${others}  A = 2\r\n  export\tA=3`)
    await saveSecret('A', 'new', file)
    expect(await readFile(file, 'utf8')).toBe(`${others}A=new\n`)
  })
})
