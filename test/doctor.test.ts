import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { parseConfig } from '../src/config/load.js'
import type { Exec } from '../src/forge/gh.js'
import { workflow } from '../src/scheduler/github-actions.js'
import { recorded } from './fakes/gh.js'

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
  const original = await importOriginal<typeof import('../src/config/paths.js')>()
  // bin looks a name up once per process, so a test's fake docker comes in through the env.
  const bin = (name: string) => (name === 'docker' && process.env.FAKE_DOCKER) || original.bin(name)
  const runsDir = mkdtempSync(join(tmpdir(), 'awaywork-runs-'))
  return { ...original, configDir, runsDir, bin }
})

const { bitbucketChecks, containerChecks, isolationChecks, runChecks, workflowSecretChecks } =
  await import('../src/cli/doctor.js')
const { configDir, runsDir } = await import('../src/config/paths.js')

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
      detail: `queue[0]: unknown skill "nope" (not built in, not in ${join(dir, 'skills')}); fine only if every repo it runs in has it in .awaywork/skills, or as an extra in .claude/skills or .agents/skills; a run fails wherever it is missing`,
    })
    expect(checks.at(-1)?.what).toBe('github')
  })
})

describe('doctor on Bitbucket', () => {
  const twgFixture = (name: string) =>
    readFile(join(import.meta.dirname, 'fixtures', 'twg', name), 'utf8')
  const config = (repos: string) =>
    parseConfig(`providers: [codex]\nsources: { bitbucket: { repos: ${repos} } }\n`)
  beforeEach(() => {
    vi.stubEnv('GIT_SSH_COMMAND', '')
    vi.stubEnv('GIT_SSH', '')
  })
  afterEach(() => vi.unstubAllEnvs())

  it('checks twg instead of gh', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'awaywork-doctor-'))
    const path = join(dir, 'config.yml')
    await writeFile(path, 'providers: [codex]\nsources: { bitbucket: { repos: [acme/api] } }\n')
    const checks = await runChecks(path, () => {})
    const what = checks.map((c) => c.what)
    expect(what).toEqual(expect.arrayContaining(['twg', 'twg acme']))
    expect(what).not.toContain('gh')
    expect(what).not.toContain('gh login')
  })

  it("checks each workspace's login, an SSH key that needs no passphrase, and the login's storage", async () => {
    const storage = (await twgFixture('auth-storage.json')).replace('"file"', '"keychain"')
    const run = recorded([
      [/workspace get -w andrea89 /, await twgFixture('workspace.json')],
      [/^git ls-remote/, '44a1dfd4d436528bb6b67192292d83276c2b7962\tHEAD'],
      [/auth storage status/, storage],
    ])
    const checks = await bitbucketChecks(config('[andrea89/awaywork-sandbox]'), run)
    expect(checks).toEqual([
      { status: 'ok', what: 'twg andrea89', detail: '' },
      { status: 'ok', what: 'git over ssh', detail: 'andrea89/awaywork-sandbox' },
      {
        status: 'warn',
        what: 'twg login',
        detail: 'stored in keychain: masking it from workers is verified only for file storage',
      },
    ])
    expect(run.calls[2]).toEqual([
      'git',
      'ls-remote',
      'git@bitbucket.org:andrea89/awaywork-sandbox.git',
      'HEAD',
    ])
  })

  it('fails a workspace twg can’t read and a key that asks for a passphrase', async () => {
    const authInvalid = await twgFixture('auth-invalid.json')
    const envs: (Record<string, string> | undefined)[] = []
    const run: Exec = async (cmd, args, env) => {
      envs.push(env)
      if (cmd === 'git')
        throw Object.assign(new Error('Command failed with exit code 128'), {
          stderr:
            'git@bitbucket.org: Permission denied (publickey).\nfatal: Could not read from remote repository.',
        })
      if (args.includes('query')) return '[{ "full_name": "acme/web" }]'
      if (args.includes('storage')) return twgFixture('auth-storage.json')
      throw Object.assign(new Error('Command failed with exit code 77'), { stdout: authInvalid })
    }
    expect(await bitbucketChecks(config('[acme/*]'), run)).toEqual([
      {
        status: 'FAIL',
        what: 'twg acme',
        detail:
          'twg bb workspace get: Bitbucket Cloud authentication required: no Bitbucket token configured; log in with twg setup bitbucket, or set TWG_BBC_TOKEN',
      },
      {
        status: 'FAIL',
        what: 'git over ssh',
        detail:
          'acme/web: git@bitbucket.org: Permission denied (publickey); add a key without a passphrase to Bitbucket, or keep one in an agent the scheduler sees',
      },
    ])
    expect(envs).toContainEqual({ GIT_SSH_COMMAND: 'ssh -o BatchMode=yes' })
  })

  it('adds BatchMode to the ssh command git would use: GIT_SSH_COMMAND, else core.sshCommand', async () => {
    const envs: (Record<string, string> | undefined)[] = []
    const run: Exec = async (_cmd, args, env) => {
      envs.push(env)
      if (args[0] === 'config') return 'ssh -i ~/.ssh/bitbucket\n'
      return args.includes('storage') ? twgFixture('auth-storage.json') : '{}'
    }
    await bitbucketChecks(config('[acme/web]'), run)
    expect(envs).toContainEqual({ GIT_SSH_COMMAND: 'ssh -i ~/.ssh/bitbucket -o BatchMode=yes' })
    vi.stubEnv('GIT_SSH_COMMAND', 'ssh -i ~/.ssh/env')
    await bitbucketChecks(config('[acme/web]'), run)
    expect(envs).toContainEqual({ GIT_SSH_COMMAND: 'ssh -i ~/.ssh/env -o BatchMode=yes' })
  })

  it('leaves a GIT_SSH wrapper to git, since it may be plink, which takes no -o', async () => {
    vi.stubEnv('GIT_SSH', '/usr/local/bin/plink')
    const calls: [string[], Record<string, string> | undefined][] = []
    const run: Exec = async (_cmd, args, env) => {
      calls.push([args, env])
      if (args[0] === 'config') return ''
      return args.includes('storage') ? twgFixture('auth-storage.json') : '{}'
    }
    await bitbucketChecks(config('[acme/web]'), run)
    expect(calls).toContainEqual([
      ['ls-remote', 'git@bitbucket.org:acme/web.git', 'HEAD'],
      undefined,
    ])
  })
})

describe('doctor on isolation', () => {
  it('warns on none, pointing at the guide', async () => {
    expect(await isolationChecks('none', {})).toEqual([
      {
        status: 'warn',
        what: 'isolation',
        detail:
          'none: setup, the agent and the checks run as you, your logins in reach; see https://andreaprovenzale.github.io/awaywork/guide/safety#not-a-sandbox',
      },
    ])
  })

  it('fails container where docker doesn’t answer', async () => {
    vi.stubEnv('DOCKER_HOST', 'unix:///nonexistent/docker.sock')
    const config = parseConfig(
      'isolation: container\nproviders: [claude]\nsources: { github: { repos: [acme/api] } }\nrepos: { acme/api: { image: acme/api:dev } }',
    )
    const checks = await containerChecks(config, process.env)
    vi.unstubAllEnvs()
    expect(checks).toHaveLength(1)
    expect(checks[0]?.status).toBe('FAIL')
    expect(checks[0]?.detail).toMatch(/^container, but docker isn't reachable \(.+\)$/)
  })

  it('fails container where docker never answers, rather than wait on it', async () => {
    const fakes = await mkdtemp(join(tmpdir(), 'awaywork-docker-'))
    await writeFile(join(fakes, 'docker'), '#!/bin/sh\nexec sleep 600\n', { mode: 0o755 })
    vi.stubEnv('FAKE_DOCKER', join(fakes, 'docker'))
    const config = parseConfig(
      'isolation: container\nproviders: [claude]\nsources: { github: { repos: [acme/api] } }\nrepos: { acme/api: { image: acme/api:dev } }',
    )
    const started = Date.now()
    const checks = await containerChecks(config, process.env, 500)
    vi.unstubAllEnvs()
    expect(Date.now() - started).toBeLessThan(5000)
    expect(checks).toHaveLength(1)
    expect(checks[0]?.detail).toMatch(/^container, but docker isn't reachable \(.*timed out/)
  })

  it('fails container where the engine can’t mount the run dir', async () => {
    const fakes = await mkdtemp(join(tmpdir(), 'awaywork-docker-'))
    const docker = [
      '#!/bin/sh',
      'case "$*" in',
      "  *--mount*) echo 'docker: Error response from daemon: bind source path does not exist' >&2; exit 125;;",
      '  version*) echo 27.4.0;;',
      'esac',
    ]
    await writeFile(join(fakes, 'docker'), `${docker.join('\n')}\n`, { mode: 0o755 })
    vi.stubEnv('FAKE_DOCKER', join(fakes, 'docker'))
    const config = parseConfig(
      'isolation: container\nproviders: [claude]\nsources: { github: { repos: [acme/api] } }\nrepos: { acme/api: { image: acme/api:dev } }',
    )
    const checks = await containerChecks(config, process.env)
    vi.unstubAllEnvs()
    expect(checks).toContainEqual({
      status: 'FAIL',
      what: 'isolation',
      detail: `the engine can't mount ${runsDir}, where the clones go (docker: Error response from daemon: bind source path does not exist): share it with the engine's VM`,
    })
  })

  it('mounts an empty folder under the run dir for its check, never the past runs, and removes it', async () => {
    await mkdir(join(runsDir, '20261020-000000'), { recursive: true })
    const fakes = await mkdtemp(join(tmpdir(), 'awaywork-docker-'))
    const docker = [
      '#!/bin/sh',
      'case "$*" in',
      '  *--mount*) src="$*"; src=${src#*source=}; src=${src%%,*}; echo "$src" > "$0.src"; ls -A "$src" > "$0.ls";;',
      '  version*) echo 27.4.0;;',
      'esac',
    ]
    await writeFile(join(fakes, 'docker'), `${docker.join('\n')}\n`, { mode: 0o755 })
    vi.stubEnv('FAKE_DOCKER', join(fakes, 'docker'))
    const config = parseConfig(
      'isolation: container\nproviders: [claude]\nsources: { github: { repos: [acme/api] } }\nrepos: { acme/api: { image: acme/api:dev } }',
    )
    await containerChecks(config, process.env)
    vi.unstubAllEnvs()
    const mounted = (await readFile(join(fakes, 'docker.src'), 'utf8')).trim()
    expect(mounted.startsWith(join(runsDir, '.mount-check-'))).toBe(true)
    expect(await readFile(join(fakes, 'docker.ls'), 'utf8')).toBe('')
    expect(existsSync(mounted)).toBe(false)
  })

  // Where the worker user exists, real-isolation.test.ts runs.
  it.skipIf(process.env.AWAYWORK_WORKER_TEST)(
    'fails user it can’t run as, with the setup to paste on Linux',
    async () => {
      const [check] = await isolationChecks('user', {})
      expect(check?.status).toBe('FAIL')
      if (process.platform !== 'linux')
        expect(check?.detail).toBe(
          `user, but isolation: user runs on Linux only, not ${process.platform}`,
        )
      else {
        expect(check?.detail).toMatch(
          /^user, but can't run as the awaywork user \(.*\); make the worker user once:\n/,
        )
        expect(check?.detail).toContain('ALL=(awaywork) NOPASSWD:SETENV: ALL')
      }
    },
  )
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
