import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { leftoverWarning } from '../src/cli/schedule.js'
import type { Exec } from '../src/forge/gh.js'
import { workflow } from '../src/scheduler/github-actions.js'

vi.mock('../src/forge/gh.js', () => ({
  exec: async (cmd: string, args: string[]) => {
    if (cmd === 'git') return 'git version 2.50.0\nextra'
    throw new Error(`${cmd} ${args.join(' ')}: not found`)
  },
}))

vi.mock('../src/config/paths.js', async (importOriginal) => {
  const { mkdtempSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const configDir = mkdtempSync(join(tmpdir(), 'awaywork-config-'))
  return { ...(await importOriginal<object>()), configDir }
})

const { runChecks, workflowSecretChecks } = await import('../src/cli/doctor.js')
const { configDir } = await import('../src/config/paths.js')

describe('doctor', () => {
  it('reports each check as { status, what, detail } and stops at a missing config', async () => {
    const path = join(import.meta.dirname, 'fixtures', 'missing.yml')
    const seen: unknown[] = []
    vi.stubEnv('GH_TOKEN', '')
    const checks = await runChecks(path, (c) => seen.push(c))
    vi.unstubAllEnvs()
    expect(seen).toEqual(checks)
    expect(checks).toContainEqual({
      status: 'ok',
      what: 'git',
      detail: 'git version 2.50.0',
    })
    expect(checks).toContainEqual({ status: 'FAIL', what: 'gh', detail: 'not found on PATH' })
    expect(checks).toContainEqual({ status: 'FAIL', what: 'gh login', detail: 'GH_TOKEN unset' })
    expect(checks.at(-1)).toEqual({ status: 'FAIL', what: path, detail: 'file not found' })
  })

  it("warns that the default skills aren't used with a config elsewhere, without parsing them", async () => {
    await mkdir(join(configDir, 'skills/mine'), { recursive: true })
    await writeFile(
      join(configDir, 'skills/mine/SKILL.md'),
      '---\ndescription: Fix CI: retry\n---\n',
    )
    const elsewhere = await mkdtemp(join(tmpdir(), 'awaywork-elsewhere-'))
    expect(await runChecks(join(elsewhere, 'config.yml'), () => {})).toContainEqual({
      status: 'warn',
      what: join(configDir, 'skills'),
      detail: `not used with this config; move or link its skills to ${join(elsewhere, 'skills')}`,
    })
    const own = await runChecks(join(configDir, 'config.yml'), () => {})
    expect(own.map((c) => c.what)).not.toContain(join(configDir, 'skills'))
  })

  it('warns about a skill it can find nowhere, since it may be in the repo', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'awaywork-doctor-'))
    const path = join(dir, 'config.yml')
    const config = 'providers: [codex]\nsources: { github: { repos: [a/b] } }\n'
    vi.stubEnv('RUNNER_ENVIRONMENT', 'github-hosted')
    await writeFile(path, config)
    expect(await runChecks(path, () => {})).toContainEqual({ status: 'ok', what: path, detail: '' })
    await writeFile(path, `${config}queue: [{ skill: nope }]\n`)
    const checks = await runChecks(path, () => {})
    vi.unstubAllEnvs()
    expect(checks).toContainEqual({
      status: 'warn',
      what: path,
      detail: `queue[0]: unknown skill "nope" (not built in, not in ${join(dir, 'skills')}); fine for a skill the repo has in .awaywork/skills`,
    })
    expect(checks.at(-1)?.what).toBe('github')
  })
})

describe('doctor in a control repo', () => {
  const SECRETS = ['GH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN', 'SLACK_WEBHOOK']

  /** A control repo with alice's workflow, with an environment or not, and a fake gh listing these secrets. */
  async function check(
    gh: { env?: string[]; repo?: string[]; org?: string[]; fail?: RegExp },
    environment = true,
  ) {
    const root = await mkdtemp(join(tmpdir(), 'awaywork-repo-'))
    await mkdir(join(root, '.github/workflows'), { recursive: true })
    await writeFile(
      join(root, '.github/workflows/awaywork-alice.yml'),
      workflow({
        starts: [{ hour: 22, minute: 0 }],
        timezone: 'Europe/Rome',
        config: '.awaywork/alice/config.yml',
        version: '1.0.0',
        packages: [],
        secrets: SECRETS,
        setup: [],
        person: { name: 'alice', personal: SECRETS.slice(0, 2), environment },
      }),
    )
    const calls: string[] = []
    const run: Exec = async (cmd, args) => {
      const call = [cmd, ...args].join(' ')
      calls.push(call)
      if (gh.fail?.test(call))
        throw Object.assign(new Error('failed'), { stderr: 'gh: Not Found (HTTP 404)' })
      if (call === 'gh api repos/{owner}/{repo} --jq .owner.type')
        return gh.org ? 'Organization' : 'User'
      if (call.includes('organization-secrets')) return (gh.org ?? []).join('\n')
      if (args.includes('--env')) return (gh.env ?? []).join('\n')
      return (gh.repo ?? []).join('\n')
    }
    return { checks: await workflowSecretChecks(root, run), calls }
  }

  it('finds every secret in the environment, the repo or the org', async () => {
    const { checks, calls } = await check({
      env: ['GH_TOKEN__ALICE', 'CLAUDE_CODE_OAUTH_TOKEN__ALICE'],
      org: ['SLACK_WEBHOOK'],
    })
    expect(calls).toContain('gh secret list --env alice --json name --jq .[].name')
    expect(checks).toEqual([
      { status: 'ok', what: 'awaywork-alice.yml', detail: 'secrets found: 3' },
    ])
  })

  it("names each missing secret and where it goes, the person's own by their suffix", async () => {
    const { checks } = await check({ env: ['GH_TOKEN__ALICE'] })
    expect(checks).toEqual([
      {
        status: 'FAIL',
        what: 'awaywork-alice.yml',
        detail:
          'add CLAUDE_CODE_OAUTH_TOKEN__ALICE to environment alice; add SLACK_WEBHOOK to the repository secrets',
      },
    ])
  })

  it('checks suffixed names at repo level without an environment', async () => {
    const found = await check(
      { repo: ['GH_TOKEN__ALICE', 'CLAUDE_CODE_OAUTH_TOKEN__ALICE', 'SLACK_WEBHOOK'] },
      false,
    )
    expect(found.calls.some((call) => call.includes('--env'))).toBe(false)
    expect(found.checks).toEqual([
      { status: 'ok', what: 'awaywork-alice.yml', detail: 'secrets found: 3' },
    ])
    const missing = await check({ repo: ['GH_TOKEN', 'SLACK_WEBHOOK'] }, false)
    expect(missing.checks).toEqual([
      {
        status: 'FAIL',
        what: 'awaywork-alice.yml',
        detail: 'add GH_TOKEN__ALICE, CLAUDE_CODE_OAUTH_TOKEN__ALICE to the repository secrets',
      },
    ])
  })

  it("warns about a fallback's suffixed secrets left at repo level once there is an environment", async () => {
    const { checks } = await check({
      env: ['GH_TOKEN__ALICE', 'CLAUDE_CODE_OAUTH_TOKEN__ALICE'],
      repo: ['GH_TOKEN__ALICE', 'GH_TOKEN__BOB', 'SLACK_WEBHOOK'],
    })
    expect(checks).toEqual([
      { status: 'ok', what: 'awaywork-alice.yml', detail: 'secrets found: 3' },
      {
        status: 'warn',
        what: 'awaywork-alice.yml',
        detail: leftoverWarning('alice', ['GH_TOKEN__ALICE']),
      },
    ])
  })

  it("warns, never fails, when the secrets can't be listed", async () => {
    const repo = await check({ fail: /^gh secret list --json/ })
    expect(repo.checks).toEqual([
      {
        status: 'warn',
        what: 'workflow secrets',
        detail: "couldn't list the repo's: gh: Not Found (HTTP 404)",
      },
    ])
    const org = await check({ fail: /^gh api repos\/\{owner\}\/\{repo\} / })
    expect(org.checks).toEqual([
      {
        status: 'warn',
        what: 'workflow secrets',
        detail: "couldn't list the organization's: gh: Not Found (HTTP 404)",
      },
    ])
    const env = await check({ fail: /--env/ })
    expect(env.checks).toEqual([
      {
        status: 'warn',
        what: 'awaywork-alice.yml',
        detail: "couldn't list environment alice's secrets: gh: Not Found (HTTP 404)",
      },
    ])
  })

  it("fails a workflow that doesn't parse and checks the rest", async () => {
    const root = await mkdtemp(join(tmpdir(), 'awaywork-repo-'))
    const dir = join(root, '.github/workflows')
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, 'awaywork-a.yml'), 'jobs: { n: { env: [ }')
    await writeFile(join(dir, 'awaywork-b.yml'), 'jobs: { n: }')
    await writeFile(join(dir, 'awaywork-d.yml'), 'jobs: { n: { env: { A: "${{ secrets.A }}" } } }')
    const run: Exec = async (_cmd, args) => (args[1] === 'repos/{owner}/{repo}' ? 'User' : 'A')
    const checks = await workflowSecretChecks(root, run)
    expect(checks.map((c) => [c.status, c.what])).toEqual([
      ['FAIL', 'awaywork-a.yml'],
      ['FAIL', 'awaywork-b.yml'],
      ['ok', 'awaywork-d.yml'],
    ])
    expect(checks.every((c) => !c.detail.includes('\n'))).toBe(true)
  })

  it('adds no checks to a repo without awaywork workflows', async () => {
    const calls: string[] = []
    const run: Exec = async (cmd, args) => {
      calls.push([cmd, ...args].join(' '))
      return ''
    }
    const root = await mkdtemp(join(tmpdir(), 'awaywork-repo-'))
    expect(await workflowSecretChecks(root, run)).toEqual([])
    expect(calls).toEqual([])
  })
})
