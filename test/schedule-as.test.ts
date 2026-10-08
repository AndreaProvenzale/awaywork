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
import { scriptedAsk } from './fakes/ask.js'

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

/** A control repo and a user's config with one skill, answered by a fake gh. */
async function setup(gh: { refuse?: boolean; policies?: string; org?: string } = {}) {
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
    if (args[2] === 'PUT' && gh.refuse)
      throw Object.assign(new Error('Command failed with exit code 1'), {
        stderr: 'gh: Must have admin rights to Repository. (HTTP 403)',
      })
    if (args[0] === 'repo') return 'main'
    if (call.endsWith('deployment-branch-policies --jq .branch_policies[].name'))
      return gh.policies ?? ''
    if (args[1] === 'list') return 'DATABASE_URL\nOTHER'
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
    setSecret: async (args: string[], value: string) => void set.push([...args, value]),
  })
  const install = (script: [RegExp, unknown][] = []) => installWorkflow(config, 'alice', io(script))
  const job = async () =>
    parse(await readFile(join(root, '.github/workflows/night-shift-alice.yml'), 'utf8')).jobs.night
  return { root, home, config, calls, set, install, job }
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
    [/^Set GH_TOKEN in environment alice from your env\?$/, true],
    [/^Set the SLACK_WEBHOOK repository secret, shared with the team, from your env\?$/, true],
  ])
  expect(calls).toContain(
    'gh api -X PUT repos/{owner}/{repo}/environments/alice -F deployment_branch_policy[protected_branches]=false -F deployment_branch_policy[custom_branch_policies]=true',
  )
  expect(calls).toContain(
    'gh api -X POST repos/{owner}/{repo}/environments/alice/deployment-branch-policies -f name=main',
  )
  expect((await job()).environment).toEqual({ name: 'alice', deployment: false })
  expect((await job()).env.GH_TOKEN).toBe('${{ secrets.GH_TOKEN }}')
  expect(await readFile(join(root, '.night-shift/alice/config.yml'), 'utf8')).toBe(CONFIG)
  expect(await readFile(join(root, '.night-shift/alice/skills/mine/SKILL.md'), 'utf8')).toBe('MINE')
  expect(existsSync(join(root, '.night-shift/config.yml'))).toBe(false)
  expect(set).toEqual([
    ['GH_TOKEN', '--env', 'alice', 'ghp_secret'],
    ['SLACK_WEBHOOK', 'hook_secret'],
  ])
  expect(out).toContain('Already repository or organization secrets: DATABASE_URL, MCP_DB_URL')
  expect(out).toContain('  commit .github/workflows/night-shift-alice.yml and .night-shift/alice/')
  expect(out).toContain(
    '  add these secrets to environment alice: CLAUDE_CODE_OAUTH_TOKEN, ASANA_TOKEN',
  )
  expect(out).toContain('  add these repository secrets: HOOK_TOKEN')
  expect(out.join('\n')).not.toMatch(/_secret/)
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
    [/^Set the GH_TOKEN__ALICE repository secret from your env\?$/, true],
    [/^Set the SLACK_WEBHOOK repository secret, shared/, false],
  ])
  expect(out[0]).toBe(
    "Couldn't create the environment alice: gh: Must have admin rights to Repository. (HTTP 403)",
  )
  expect(out[1]).toMatch(/no branch limit: any branch's workflow can read every teammate's token/)
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

it('syncs again: unchanged says so, changed shows the diff and asks, declined keeps', async () => {
  const { root, home, config, install } = await setup()
  const secrets = (): [RegExp, unknown][] => [
    [/GH_TOKEN/, false],
    [/SLACK_WEBHOOK/, false],
  ]
  await install(secrets())
  await writeFile(join(root, '.github/workflows/night-shift-alice.yml'), 'stale')
  out = []
  await install(secrets())
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
    [/^Overwrite \.night-shift\/alice\/skills with the changes above\?$/, true],
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
  const { calls } = await setup()
  for (const name of ['Alice', '-alice', '../alice', 'a_b']) {
    await installWorkflow(undefined, name)
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
