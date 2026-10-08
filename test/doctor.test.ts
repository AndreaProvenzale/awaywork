import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type { Exec } from '../src/forge/gh.js'
import { workflow } from '../src/scheduler/github-actions.js'

vi.mock('../src/forge/gh.js', () => ({
  exec: async (cmd: string, args: string[]) => {
    if (cmd === 'git') return 'git version 2.50.0\nextra'
    throw new Error(`${cmd} ${args.join(' ')}: not found`)
  },
}))

const { runChecks, workflowSecretChecks } = await import('../src/cli/doctor.js')

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
})

describe('doctor in a control repo', () => {
  const CONFIG = `providers: [claude]
sources: { github: { repos: [acme/api] } }
notify: { command: "true", secrets: [SLACK_WEBHOOK] }
`
  const SECRETS = ['GH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN', 'SLACK_WEBHOOK']

  /** A control repo with alice's workflow, in an environment unless suffixed, and a fake gh listing these secrets. */
  async function check(
    gh: { env?: string[]; repo?: string[]; org?: string[]; fail?: RegExp },
    suffixed?: string[],
  ) {
    const root = await mkdtemp(join(tmpdir(), 'nightshift-repo-'))
    await mkdir(join(root, '.github/workflows'), { recursive: true })
    await mkdir(join(root, '.night-shift/alice'), { recursive: true })
    await writeFile(join(root, '.night-shift/alice/config.yml'), CONFIG)
    await writeFile(
      join(root, '.github/workflows/night-shift-alice.yml'),
      workflow({
        starts: [{ hour: 22, minute: 0 }],
        timezone: 'Europe/Rome',
        config: '.night-shift/alice/config.yml',
        version: '1.0.0',
        packages: [],
        secrets: SECRETS,
        setup: [],
        person: { name: 'alice', suffixed },
      }),
    )
    const calls: string[] = []
    const run: Exec = async (cmd, args) => {
      const call = [cmd, ...args].join(' ')
      calls.push(call)
      if (gh.fail?.test(call))
        throw Object.assign(new Error('failed'), { stderr: 'gh: Not Found (HTTP 404)' })
      if (args[1] === 'repos/{owner}/{repo}')
        return JSON.stringify({ login: 'acme', type: gh.org ? 'Organization' : 'User' })
      if (call.includes('organization-secrets')) return (gh.org ?? []).join('\n')
      if (args.includes('--env')) return (gh.env ?? []).join('\n')
      return (gh.repo ?? []).join('\n')
    }
    return { checks: await workflowSecretChecks(root, run), calls }
  }

  it('finds every secret in the environment, the repo or the org', async () => {
    const { checks, calls } = await check({
      env: ['GH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN'],
      org: ['SLACK_WEBHOOK'],
    })
    expect(calls).toContain('gh secret list --env alice --json name --jq .[].name')
    expect(checks).toEqual([
      { status: 'ok', what: 'night-shift-alice.yml', detail: 'secrets found: 3' },
    ])
  })

  it('names each missing secret and where it goes', async () => {
    const { checks } = await check({ env: ['GH_TOKEN'] })
    expect(checks).toEqual([
      {
        status: 'FAIL',
        what: 'night-shift-alice.yml',
        detail:
          'add CLAUDE_CODE_OAUTH_TOKEN to environment alice; add SLACK_WEBHOOK to the repository secrets',
      },
    ])
  })

  it("warns when a repo or org secret stands in for one the person's environment lacks", async () => {
    const { checks } = await check({
      env: [],
      repo: ['GH_TOKEN', 'SLACK_WEBHOOK'],
      org: ['CLAUDE_CODE_OAUTH_TOKEN'],
    })
    expect(checks[0]).toEqual({
      status: 'ok',
      what: 'night-shift-alice.yml',
      detail: 'secrets found: 3',
    })
    expect(checks[1]?.status).toBe('warn')
    expect(checks[1]?.detail).toMatch(
      /^GH_TOKEN, CLAUDE_CODE_OAUTH_TOKEN already exist at repo or org level and stand in for any that environment alice lacks/,
    )
    expect(checks[1]?.detail).toMatch(
      /`gh secret delete GH_TOKEN`, `gh secret delete CLAUDE_CODE_OAUTH_TOKEN --org acme`/,
    )
  })

  it('checks suffixed names at repo level without an environment', async () => {
    const personal = ['GH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN']
    const found = await check(
      { repo: ['GH_TOKEN__ALICE', 'CLAUDE_CODE_OAUTH_TOKEN__ALICE', 'SLACK_WEBHOOK'] },
      personal,
    )
    expect(found.calls.some((call) => call.includes('--env'))).toBe(false)
    expect(found.checks).toEqual([
      { status: 'ok', what: 'night-shift-alice.yml', detail: 'secrets found: 3' },
    ])
    const missing = await check({ repo: ['GH_TOKEN', 'SLACK_WEBHOOK'] }, personal)
    expect(missing.checks).toEqual([
      {
        status: 'FAIL',
        what: 'night-shift-alice.yml',
        detail: 'add GH_TOKEN__ALICE, CLAUDE_CODE_OAUTH_TOKEN__ALICE to the repository secrets',
      },
    ])
  })

  it("warns, never fails, when the secrets can't be listed", async () => {
    const repo = await check({ fail: /^gh api repos\/\{owner\}\/\{repo\} / })
    expect(repo.checks).toEqual([
      {
        status: 'warn',
        what: 'workflow secrets',
        detail: "couldn't list them: gh: Not Found (HTTP 404)",
      },
    ])
    const env = await check({ fail: /--env/ })
    expect(env.checks).toEqual([
      {
        status: 'warn',
        what: 'night-shift-alice.yml',
        detail: "couldn't list environment alice's secrets: gh: Not Found (HTTP 404)",
      },
    ])
  })

  it("fails a workflow that doesn't parse and checks the rest", async () => {
    const root = await mkdtemp(join(tmpdir(), 'nightshift-repo-'))
    const dir = join(root, '.github/workflows')
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, 'night-shift-a.yml'), 'jobs: { n: { env: [ }')
    await writeFile(join(dir, 'night-shift-b.yml'), 'jobs: { n: }')
    await writeFile(join(dir, 'night-shift-c.yml'), 'jobs: { n: { steps: { a: 1 } } }')
    await writeFile(
      join(dir, 'night-shift-d.yml'),
      'jobs: { n: { env: { A: "${{ secrets.A }}" } } }',
    )
    const run: Exec = async (_cmd, args) =>
      args[1] === 'repos/{owner}/{repo}' ? JSON.stringify({ login: 'acme', type: 'User' }) : 'A'
    const checks = await workflowSecretChecks(root, run)
    expect(checks.map((c) => [c.status, c.what])).toEqual([
      ['FAIL', 'night-shift-a.yml'],
      ['FAIL', 'night-shift-b.yml'],
      ['FAIL', 'night-shift-c.yml'],
      ['ok', 'night-shift-d.yml'],
    ])
    expect(checks.every((c) => !c.detail.includes('\n'))).toBe(true)
  })

  it('adds no checks to a repo without night-shift workflows', async () => {
    const calls: string[] = []
    const run: Exec = async (cmd, args) => {
      calls.push([cmd, ...args].join(' '))
      return ''
    }
    const root = await mkdtemp(join(tmpdir(), 'nightshift-repo-'))
    expect(await workflowSecretChecks(root, run)).toEqual([])
    expect(calls).toEqual([])
  })
})
