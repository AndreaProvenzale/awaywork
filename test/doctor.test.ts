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
      detail: `queue[0]: unknown skill "nope" (not built in, not in ${join(dir, 'skills')}); fine for a skill the repo has in .awaywork/skills, or for an extra one in .claude/skills or .agents/skills`,
    })
    expect(checks.at(-1)?.what).toBe('github')
  })
})

describe('doctor in a control repo', () => {
  const SECRETS = ['GH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN', 'SLACK_WEBHOOK']

  /** A control repo with its workflow, and a fake gh listing these secrets. */
  async function check(gh: { repo?: string[]; org?: string[]; fail?: RegExp }) {
    const root = await mkdtemp(join(tmpdir(), 'awaywork-repo-'))
    await mkdir(join(root, '.github/workflows'), { recursive: true })
    await writeFile(
      join(root, '.github/workflows/awaywork.yml'),
      workflow({
        starts: [{ hour: 22, minute: 0 }],
        timezone: 'Europe/Rome',
        config: '.awaywork/config.yml',
        version: '1.0.0',
        packages: [],
        secrets: SECRETS,
        setup: [],
      }),
    )
    const run: Exec = async (cmd, args) => {
      const call = [cmd, ...args].join(' ')
      if (gh.fail?.test(call))
        throw Object.assign(new Error('failed'), { stderr: 'gh: Not Found (HTTP 404)' })
      if (call === 'gh api repos/{owner}/{repo} --jq .owner.type')
        return gh.org ? 'Organization' : 'User'
      if (call.includes('organization-secrets')) return (gh.org ?? []).join('\n')
      return (gh.repo ?? []).join('\n')
    }
    return workflowSecretChecks(root, run)
  }

  it('finds every secret in the repo or the org', async () => {
    const checks = await check({
      repo: ['GH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN'],
      org: ['SLACK_WEBHOOK'],
    })
    expect(checks).toEqual([{ status: 'ok', what: 'awaywork.yml', detail: 'secrets found: 3' }])
  })

  it('names each missing secret', async () => {
    const checks = await check({ repo: ['GH_TOKEN'] })
    expect(checks).toEqual([
      {
        status: 'FAIL',
        what: 'awaywork.yml',
        detail: 'add CLAUDE_CODE_OAUTH_TOKEN, SLACK_WEBHOOK to the repository secrets',
      },
    ])
  })

  it("warns, never fails, when the secrets can't be listed", async () => {
    expect(await check({ fail: /^gh secret list --json/ })).toEqual([
      {
        status: 'warn',
        what: 'workflow secrets',
        detail: "couldn't list the repo's: gh: Not Found (HTTP 404)",
      },
    ])
    expect(await check({ fail: /^gh api repos\/\{owner\}\/\{repo\} / })).toEqual([
      {
        status: 'warn',
        what: 'workflow secrets',
        detail: "couldn't list the organization's: gh: Not Found (HTTP 404)",
      },
    ])
  })

  it("fails a workflow that doesn't parse", async () => {
    const root = await mkdtemp(join(tmpdir(), 'awaywork-repo-'))
    await mkdir(join(root, '.github/workflows'), { recursive: true })
    const run: Exec = async (_cmd, args) => (args[1] === 'repos/{owner}/{repo}' ? 'User' : 'A')
    const checksOf = async (text: string) => {
      await writeFile(join(root, '.github/workflows/awaywork.yml'), text)
      return workflowSecretChecks(root, run)
    }
    const checks = [
      ...(await checksOf('jobs: { n: { env: [ }')),
      ...(await checksOf('jobs: { n: }')),
      ...(await checksOf('jobs: { n: { env: { A: "${{ secrets.A }}" } } }')),
    ]
    expect(checks.map((c) => [c.status, c.what])).toEqual([
      ['FAIL', 'awaywork.yml'],
      ['FAIL', 'awaywork.yml'],
      ['ok', 'awaywork.yml'],
    ])
    expect(checks.every((c) => !c.detail.includes('\n'))).toBe(true)
  })

  it('adds no checks to a repo without the awaywork workflow', async () => {
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
