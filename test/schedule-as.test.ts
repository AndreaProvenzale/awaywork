// biome-ignore-all lint/suspicious/noTemplateCurlyInString: GitHub Actions expressions
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { parse } from 'yaml'
import { installWorkflow, removePersonWorkflow, secretsOf, syncCopy } from '../src/cli/schedule.js'
import { parseConfig } from '../src/config/load.js'
import type { Exec } from '../src/forge/gh.js'
import { initial, scriptedAsk } from './fakes/ask.js'

const CONFIG = `providers: [claude]
sources: { github: { repos: [acme/api] }, asana: { workspace: "100" } }
repos: { acme/api: { secrets: [DATABASE_URL] } }
notify: { command: "true", secrets: [SLACK_WEBHOOK, ASANA_TOKEN] }
after_unit: { command: "true", secrets: [HOOK_TOKEN] }
mcp: { db: { command: npx, secrets: [MCP_DB_URL] } }
`

let out: string[]
beforeEach(() => {
  out = []
  vi.spyOn(console, 'log').mockImplementation((line) => void out.push(String(line)))
  vi.spyOn(console, 'error').mockImplementation((line) => void out.push(String(line)))
})
afterEach(() => {
  vi.restoreAllMocks()
  process.exitCode = undefined
})

interface Gh {
  /** What GET on the environment prints when it exists. */
  environment?: string
  /** gh's stderr when a call fails: the environment's GET, its PUT, a policy's POST. */
  get?: string
  put?: string
  post?: string
  /** The PUT fails as for someone without admin rights. */
  refuse?: boolean
  policies?: string
  repo?: string
  org?: string
  failSet?: boolean
}

const fail = (stderr: string): never => {
  throw Object.assign(new Error('Command failed with exit code 1'), { stderr })
}

const FALLBACK =
  /^Keep alice's secrets as repository secrets ending in __ALICE, which any branch's workflow can read\?$/

/** A control repo and a user's config with one skill, answered by a fake gh. */
async function setup(gh: Gh = {}) {
  const root = await mkdtemp(join(tmpdir(), 'nightshift-repo-'))
  const home = await mkdtemp(join(tmpdir(), 'nightshift-home-'))
  const config = join(home, 'config.yml')
  await writeFile(config, CONFIG)
  await mkdir(join(home, 'skills/mine'), { recursive: true })
  await writeFile(join(home, 'skills/mine/SKILL.md'), 'MINE')
  const calls: string[] = []
  const run: Exec = async (cmd, args) => {
    const call = [cmd, ...args].join(' ')
    calls.push(call)
    if (cmd === 'git') return root
    if (call === 'gh api repos/{owner}/{repo}/environments/alice --jq .deployment_branch_policy')
      return gh.get ? fail(gh.get) : (gh.environment ?? fail('gh: Not Found (HTTP 404)'))
    if (args[2] === 'PUT' && gh.put) fail(gh.put)
    if (args[2] === 'PUT' && gh.refuse) fail('gh: Must have admin rights to Repository. (HTTP 403)')
    if (args[2] === 'POST' && gh.post) fail(gh.post)
    if (args[0] === 'repo') return 'main'
    if (call.endsWith('deployment-branch-policies --jq .branch_policies[].name'))
      return gh.policies ?? ''
    if (args[1] === 'list') return gh.repo ?? 'DATABASE_URL\nOTHER'
    if (call.includes('organization-secrets')) {
      if (gh.org === undefined) throw new Error('gh: Validation Failed (HTTP 422)')
      return gh.org
    }
    return ''
  }
  const set: string[][] = []
  const env = { GH_TOKEN: 'ghp_secret', SLACK_WEBHOOK: 'hook_secret', DATABASE_URL: 'db_secret' }
  const io = (script: [RegExp, unknown][]) => ({
    run,
    ask: scriptedAsk(script),
    env,
    setSecret: async (args: string[], value: string) => {
      if (gh.failSet) throw new Error('gh failed')
      set.push([...args, value])
    },
  })
  const install = (script: [RegExp, unknown][] = []) => installWorkflow(config, 'alice', io(script))
  const job = async () =>
    parse(await readFile(join(root, '.github/workflows/night-shift-alice.yml'), 'utf8')).jobs.night
  return { root, home, config, calls, set, io, install, job }
}

it('splits secrets into personal and shared, a name in both being personal', () => {
  expect(secretsOf(parseConfig(CONFIG))).toEqual({
    personal: ['GH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN', 'ASANA_TOKEN'],
    shared: ['SLACK_WEBHOOK', 'HOOK_TOKEN', 'DATABASE_URL', 'MCP_DB_URL'],
  })
})

it("installs a person's environment, workflow, config and skills, and offers each secret in its layer", async () => {
  const { root, calls, set, install, job } = await setup({ org: 'MCP_DB_URL' })
  await install([
    [/^Set GH_TOKEN__ALICE in environment alice from your env\?$/, true],
    [/^Set the SLACK_WEBHOOK repository secret, shared with the team, from your env\?$/, true],
  ])
  expect(calls).toContain(
    'gh api -X PUT repos/{owner}/{repo}/environments/alice -F deployment_branch_policy[protected_branches]=false -F deployment_branch_policy[custom_branch_policies]=true',
  )
  expect(calls).toContain(
    'gh api -X POST repos/{owner}/{repo}/environments/alice/deployment-branch-policies -f name=main',
  )
  expect((await job()).environment).toEqual({ name: 'alice', deployment: false })
  expect((await job()).env.GH_TOKEN).toBe('${{ secrets.GH_TOKEN__ALICE }}')
  expect((await job()).env.SLACK_WEBHOOK).toBe('${{ secrets.SLACK_WEBHOOK }}')
  expect(await readFile(join(root, '.night-shift/alice/config.yml'), 'utf8')).toBe(CONFIG)
  expect(await readFile(join(root, '.night-shift/alice/skills/mine/SKILL.md'), 'utf8')).toBe('MINE')
  expect(existsSync(join(root, '.night-shift/config.yml'))).toBe(false)
  expect(set).toEqual([
    ['GH_TOKEN__ALICE', '--env', 'alice', 'ghp_secret'],
    ['SLACK_WEBHOOK', 'hook_secret'],
  ])
  expect(out).toContain('Already repository or organization secrets: DATABASE_URL, MCP_DB_URL')
  expect(out).toContain(
    '  commit .github/workflows/night-shift-alice.yml, .night-shift/alice/config.yml and .night-shift/alice/skills',
  )
  expect(out).toContain(
    '  add these secrets to environment alice: CLAUDE_CODE_OAUTH_TOKEN__ALICE, ASANA_TOKEN__ALICE',
  )
  expect(out).toContain('  add these repository secrets: HOOK_TOKEN')
  expect(out.join('\n')).not.toMatch(/_secret/)
  expect(out.join('\n')).not.toMatch(/^Warning/m)
})

it("never lets a repo or org secret of a personal name stand in for the person's", async () => {
  const { install, job } = await setup({ repo: 'GH_TOKEN\nDATABASE_URL', org: 'ASANA_TOKEN' })
  await install([
    [/^Set GH_TOKEN__ALICE in environment alice/, false],
    [/SLACK_WEBHOOK/, false],
  ])
  expect((await job()).env.GH_TOKEN).toBe('${{ secrets.GH_TOKEN__ALICE }}')
  expect((await job()).env.ASANA_TOKEN).toBe('${{ secrets.ASANA_TOKEN__ALICE }}')
  expect(out).toContain(
    '  add these secrets to environment alice: GH_TOKEN__ALICE, CLAUDE_CODE_OAUTH_TOKEN__ALICE, ASANA_TOKEN__ALICE',
  )
})

it('names where a failed secret was going, in either mode', async () => {
  const notes = async (gh: { refuse?: boolean }, prompt: RegExp) => {
    const { config, io } = await setup({ ...gh, failSet: true })
    const run = io([
      ...(gh.refuse ? [[FALLBACK, true] as [RegExp, unknown]] : []),
      [prompt, true],
      [/SLACK_WEBHOOK/, false],
    ])
    await installWorkflow(config, 'alice', run)
    return run.ask.notes
  }
  expect(await notes({}, /^Set GH_TOKEN__ALICE in environment alice/)).toEqual([
    '`gh secret set GH_TOKEN__ALICE --env alice` failed',
  ])
  expect(await notes({ refuse: true }, /^Set the GH_TOKEN__ALICE repository secret/)).toEqual([
    '`gh secret set GH_TOKEN__ALICE` failed',
  ])
})

it('adds no branch policy the environment already has', async () => {
  const { calls, install } = await setup({ policies: 'release\nmain' })
  await install([
    [/GH_TOKEN/, false],
    [/SLACK_WEBHOOK/, false],
  ])
  expect(calls.filter((c) => c.includes('-X POST'))).toEqual([])
})

it('falls back to suffixed repository secrets when GitHub refuses the environment', async () => {
  const { calls, set, install, job } = await setup({ refuse: true })
  await install([
    [FALLBACK, true],
    [/^Set the GH_TOKEN__ALICE repository secret from your env\?$/, true],
    [/^Set the SLACK_WEBHOOK repository secret, shared/, false],
  ])
  expect(out[0]).toBe(
    'GitHub refuses the environment alice: gh: Must have admin rights to Repository. (HTTP 403)',
  )
  expect(calls.filter((c) => c.includes('branch-policies'))).toEqual([])
  const { environment, env } = await job()
  expect(environment).toBeUndefined()
  expect(env.GH_TOKEN).toBe('${{ secrets.GH_TOKEN__ALICE }}')
  expect(env.ASANA_TOKEN).toBe('${{ secrets.ASANA_TOKEN__ALICE }}')
  expect(env.SLACK_WEBHOOK).toBe('${{ secrets.SLACK_WEBHOOK }}')
  expect(env.MCP_DB_URL).toBe('${{ secrets.MCP_DB_URL }}')
  expect(set).toEqual([['GH_TOKEN__ALICE', 'ghp_secret']])
  expect(out).toContain(
    '  add these suffixed repository secrets: CLAUDE_CODE_OAUTH_TOKEN__ALICE, ASANA_TOKEN__ALICE',
  )
  expect(out).toContain('  add these repository secrets: SLACK_WEBHOOK, HOOK_TOKEN, MCP_DB_URL')
})

it('stops when the person declines the fallback, which a refused read also leads to', async () => {
  const { root, set, install } = await setup({ get: 'gh: Resource not accessible (HTTP 403)' })
  await install([[FALLBACK, initial]])
  expect(process.exitCode).toBe(1)
  expect(existsSync(join(root, '.github/workflows/night-shift-alice.yml'))).toBe(false)
  expect(set).toEqual([])
})

it('stops without asking on an error that is no refusal', async () => {
  for (const [gh, reason] of [
    [{ get: 'gh: To get started with GitHub CLI, please run:  gh auth login' }, ''],
    [{ put: 'error connecting to api.github.com' }, ''],
    [
      { post: 'gh: Must have admin rights to Repository. (HTTP 403)' },
      'it exists, but limiting it to the default branch failed: ',
    ],
  ] as [Gh, string][]) {
    out = []
    const { root, install } = await setup(gh)
    await install()
    expect(process.exitCode).toBe(1)
    expect(out).toEqual([`Couldn't set up the environment alice: ${reason}${Object.values(gh)[0]}`])
    expect(existsSync(join(root, '.github/workflows/night-shift-alice.yml'))).toBe(false)
    process.exitCode = undefined
  }
})

it('never turns a workflow with an environment into the fallback', async () => {
  const gh: Gh = {}
  const { root, install } = await setup(gh)
  await install([
    [/GH_TOKEN/, false],
    [/SLACK_WEBHOOK/, false],
  ])
  const before = await readFile(join(root, '.github/workflows/night-shift-alice.yml'), 'utf8')
  gh.get = 'gh: Must have admin rights to Repository. (HTTP 403)'
  out = []
  await install()
  expect(process.exitCode).toBe(1)
  expect(out).toEqual([
    '.github/workflows/night-shift-alice.yml uses the environment alice, which GitHub now refuses: gh: Must have admin rights to Repository. (HTTP 403). Changed nothing',
  ])
  expect(await readFile(join(root, '.github/workflows/night-shift-alice.yml'), 'utf8')).toBe(before)
})

it('keeps an existing environment as it is, warning when any branch can deploy to it', async () => {
  for (const environment of [
    '{"custom_branch_policies":true,"protected_branches":false}',
    'null',
  ]) {
    out = []
    const { calls, install } = await setup({ environment })
    await install([
      [/GH_TOKEN/, false],
      [/SLACK_WEBHOOK/, false],
    ])
    expect(calls.filter((c) => /-X (PUT|POST)|repo view/.test(c))).toEqual([])
    expect(out).toContain('Kept the environment alice')
    expect(out.filter((line) => line.startsWith('Warning: '))).toEqual(
      environment === 'null'
        ? [
            "Warning: any branch can deploy to environment alice, so any branch's workflow can read its secrets; limit it to the default branch in the repo's Settings > Environments > alice",
          ]
        : [],
    )
  }
})

it('syncs again: unchanged says so, changed shows the diff and asks, declined keeps', async () => {
  const { root, home, config, install } = await setup()
  const secrets = (): [RegExp, unknown][] => [
    [/GH_TOKEN/, false],
    [/SLACK_WEBHOOK/, false],
  ]
  await install(secrets())
  await writeFile(join(root, '.github/workflows/night-shift-alice.yml'), 'stale')
  out = []
  await install([[/^Overwrite \.github\/workflows\/night-shift-alice\.yml/, true], ...secrets()])
  expect(out).toContain('.night-shift/alice/config.yml is up to date')
  expect(out).toContain('.night-shift/alice/skills is up to date')
  expect(await readFile(join(root, '.github/workflows/night-shift-alice.yml'), 'utf8')).not.toBe(
    'stale',
  )

  await writeFile(config, `${CONFIG}skills: [mine]\n`)
  await rm(join(home, 'skills/mine'), { recursive: true })
  await mkdir(join(home, 'skills/other'), { recursive: true })
  await writeFile(join(home, 'skills/other/SKILL.md'), 'OTHER')
  out = []
  await install([
    [/^Overwrite \.night-shift\/alice\/config\.yml with the changes above\?$/, false],
    [/^Replace all of \.night-shift\/alice\/skills with the changes above/, true],
    ...secrets(),
  ])
  expect(out.join('\n')).toContain('+skills: [mine]')
  expect(out).toContain('Kept .night-shift/alice/config.yml')
  expect(await readFile(join(root, '.night-shift/alice/config.yml'), 'utf8')).toBe(CONFIG)
  expect(existsSync(join(root, '.night-shift/alice/skills/mine'))).toBe(false)
  expect(await readFile(join(root, '.night-shift/alice/skills/other/SKILL.md'), 'utf8')).toBe(
    'OTHER',
  )
})

it('copies a file the repo lacks without asking', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nightshift-repo-'))
  const from = join(root, 'source.yml')
  await writeFile(from, 'a: 1\n')
  await syncCopy(from, root, 'x/config.yml', scriptedAsk([]))
  expect(await readFile(join(root, 'x/config.yml'), 'utf8')).toBe('a: 1\n')
})

it('refuses a person name that is not lowercase letters, digits and -', async () => {
  const { calls, io } = await setup()
  for (const name of ['Alice', '-alice', '../alice', 'a_b']) {
    await installWorkflow(undefined, name, io([]))
    expect(process.exitCode).toBe(1)
  }
  expect(calls).toEqual([])
  expect(out[0]).toMatch(/^--as takes lowercase letters, digits and -/)
})

it("removes only the person's workflow and says how to delete their environment", async () => {
  const { root, install } = await setup()
  await install([
    [/GH_TOKEN/, false],
    [/SLACK_WEBHOOK/, false],
  ])
  out = []
  const run: Exec = async () => root
  await removePersonWorkflow('alice', run)
  expect(existsSync(join(root, '.github/workflows/night-shift-alice.yml'))).toBe(false)
  expect(existsSync(join(root, '.night-shift/alice/config.yml'))).toBe(true)
  expect(out).toEqual([
    'Removed .github/workflows/night-shift-alice.yml',
    'The environment alice and its secrets stay; `gh api -X DELETE repos/{owner}/{repo}/environments/alice` deletes them',
  ])
  out = []
  await removePersonWorkflow('alice', run)
  expect(out).toEqual(['No .github/workflows/night-shift-alice.yml in this repo'])
})

it('names the suffixed repository secrets a removed fallback workflow leaves', async () => {
  const { root, install } = await setup({ refuse: true })
  await install([
    [FALLBACK, true],
    [/GH_TOKEN__ALICE/, false],
    [/SLACK_WEBHOOK/, false],
  ])
  out = []
  await removePersonWorkflow('alice', async () => root)
  expect(out).toEqual([
    'Removed .github/workflows/night-shift-alice.yml',
    'Its suffixed repository secrets stay, readable from any branch: `gh secret delete GH_TOKEN__ALICE`, `gh secret delete CLAUDE_CODE_OAUTH_TOKEN__ALICE`, `gh secret delete ASANA_TOKEN__ALICE`',
  ])
})
