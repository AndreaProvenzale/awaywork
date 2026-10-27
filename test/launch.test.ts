import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execa } from 'execa'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { parseConfig } from '../src/config/load.js'
import {
  AWAYWORK_ENV,
  dockerArgs,
  isolate,
  launch,
  sudoArgs,
  WORKER,
  workerFor,
} from '../src/core/launch.js'
import type { Job, Unit } from '../src/core/types.js'
import { claudeProvider } from '../src/providers/claude.js'
import { codexProvider } from '../src/providers/codex.js'
import { commandProvider } from '../src/providers/command.js'
import { createChecks } from '../src/worker/checks.js'
import { fetchContexts } from '../src/worker/context.js'
import { runSetup } from '../src/worker/setup.js'
import { commandEnv, gateEnv, workerEnv } from '../src/worker/workspace.js'
import { escaped, escaping } from './fakes/escape.js'
import { fakeItem } from './fakes/items.js'

vi.mock('../src/core/launch.js', async (original) => {
  const real = await original<typeof import('../src/core/launch.js')>()
  return { ...real, launch: vi.fn(real.launch) }
})

const dir = await mkdtemp(join(tmpdir(), 'awaywork-launch-'))
const fake = (name: string) => fileURLToPath(new URL(`./fakes/${name}.mjs`, import.meta.url))
const env = { PATH: process.env.PATH, HOME: process.env.HOME }
const job = { dir, prompt: 'fix it', maxTurns: 10, env, unit: { foreign: false } } as unknown as Job
const launched = () => vi.mocked(launch).mock.calls.map(([file, , options]) => [file, options.cwd])

async function drain(events: AsyncIterable<unknown>) {
  for await (const _ of events);
}

describe('the launcher', () => {
  beforeEach(() => {
    vi.mocked(launch).mockClear()
  })

  it('starts each provider’s agent', async () => {
    const lockFile = join(dir, 'codex.lock')
    await drain(claudeProvider(fake('claude')).run(job, new AbortController().signal))
    await drain(codexProvider(fake('codex'), lockFile).run(job, new AbortController().signal))
    const command = { command: 'true', secrets: [], skills_dir: '.agents/skills' }
    await drain(commandProvider('mine', command).run(job, new AbortController().signal))
    expect(launched()).toEqual([
      [fake('claude'), dir],
      [fake('codex'), dir],
      ['true', dir],
    ])
  })

  it('ends each provider’s stopped agent soon after it exits, whatever still holds its output', async () => {
    const agent = (name: string) => join(dir, `${name}.sh`)
    const providers = [
      claudeProvider(agent('claude')),
      codexProvider(agent('codex'), join(dir, 'codex.lock')),
      commandProvider('mine', {
        command: agent('mine'),
        secrets: [],
        skills_dir: '.agents/skills',
      }),
    ]
    for (const provider of providers) {
      const pid = join(dir, `${provider.id}.pid`)
      await writeFile(agent(provider.id), `#!/bin/sh\n${escaping(pid)}\nsleep 30\n`, {
        mode: 0o755,
      })
      const stop = new AbortController()
      const run = drain(provider.run(job, stop.signal))
      await escaped(pid)
      stop.abort()
      const stopped = Date.now()
      try {
        await run
      } finally {
        process.kill(await escaped(pid), 'SIGKILL')
      }
      expect(Date.now() - stopped, provider.id).toBeLessThan(5000)
    }
  }, 30_000)

  it('starts setup and the checks, not the parent’s git', async () => {
    await execa('git', ['init', '-q', dir])
    const commit = ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty']
    await execa('git', ['-C', dir, ...commit, '-m', 'start'])
    expect(await runSetup('true', dir, env, () => {}, { secrets: [] })).toBeUndefined()
    const { check, rememberGitConfig } = createChecks({ env, secrets: [] })
    rememberGitConfig(dir, await readFile(join(dir, '.git', 'config'), 'utf8'))
    const unit = { untrusted: false } as Unit
    expect((await check('exit 0', unit, dir, () => {})).failed).toBeUndefined()
    expect(launched()).toEqual([
      ['true', dir],
      ['exit 0', dir],
    ])
  })

  it('doesn’t start context commands, the config’s and not the repo’s, nor hand the worker their folder', async () => {
    // A sudo that only logs, so a chown of the config's folder shows.
    const fakes = await mkdtemp(join(tmpdir(), 'awaywork-sudo-'))
    const calls = join(fakes, 'calls')
    await writeFile(join(fakes, 'sudo'), `#!/bin/sh\necho "$*" >> ${calls}\n`, { mode: 0o755 })
    const path = process.env.PATH
    process.env.PATH = `${fakes}:${path}`
    isolate(WORKER)
    const context = { command: 'echo hi > "$AWAYWORK_CONTEXT_DIR/out.md"', secrets: [] }
    try {
      await fetchContexts([fakeItem({ source: 'github', key: 'ACME-1' })], dir, {
        config: parseConfig(
          `providers: [claude: {}]\nsources: { github: { repos: [acme/*], context: ${JSON.stringify(context)} } }`,
        ),
        configDir: dir,
        env,
        secrets: [],
        log: () => {},
      })
    } finally {
      isolate(undefined)
      process.env.PATH = path
    }
    expect(await readFile(join(dir, '.away/context/acme-1/extra/out.md'), 'utf8')).toBe('hi\n')
    expect(launched()).toEqual([])
    expect(await readFile(calls, 'utf8').catch(() => '')).toBe('')
  })

  it('runs as the worker with the env’s names on sudo’s argv, never its values', () => {
    const env = {
      PATH: '/opt/node/bin:/usr/bin',
      HOME: '/home/runner',
      XDG_CONFIG_HOME: '/home/runner/.config',
      CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-canary',
      GH_TOKEN: 'none',
      'BASH_FUNC_x%%': '() { echo canary; }',
    }
    const argv = sudoArgs('awaywork', '/opt/node/bin/claude', ['-p', 'fix it'], {
      env,
      extendEnv: false,
    })
    expect(argv).toEqual([
      '-n',
      '-u',
      'awaywork',
      '--preserve-env=PATH,CLAUDE_CODE_OAUTH_TOKEN,GH_TOKEN',
      '--',
      '/usr/bin/env',
      ...['-u', 'CODEX_HOME', '-u', 'CLAUDE_CONFIG_DIR'],
      ...['-u', 'XDG_CONFIG_HOME', '-u', 'XDG_CACHE_HOME', '-u', 'XDG_DATA_HOME'],
      ...['-u', 'XDG_STATE_HOME', '-u', 'XDG_RUNTIME_DIR'],
      '/opt/node/bin/claude',
      '-p',
      'fix it',
    ])
    for (const value of Object.values(env)) for (const arg of argv) expect(arg).not.toContain(value)
    const shell = sudoArgs('awaywork', 'npm ci && npm test', [], {
      env,
      extendEnv: false,
      shell: true,
    })
    expect(shell.slice(-3)).toEqual(['/bin/sh', '-c', 'npm ci && npm test'])
  })

  it('runs in a container with the clone and the plugin only, and the env’s names on docker’s argv, never its values', () => {
    process.env.AWAYWORK_UNCHANGED = 'yours'
    // Set the same in your own env, awaywork's still go in.
    vi.stubEnv('GIT_CONFIG_NOSYSTEM', '1')
    vi.stubEnv('ENABLE_CLAUDEAI_MCP_SERVERS', 'false')
    const env = {
      PATH: process.env.PATH,
      HOME: '/Users/dev',
      AWAYWORK_UNCHANGED: 'yours',
      CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-canary',
      GH_TOKEN: 'none',
      GIT_CONFIG_GLOBAL: `${dir}/.away/gitconfig`,
      GIT_CONFIG_NOSYSTEM: '1',
      ENABLE_CLAUDEAI_MCP_SERVERS: 'false',
      JAVA_HOME: '/Library/Java/yours',
      'BASH_FUNC_x%%': '() { echo canary; }',
    }
    const box = { image: 'acme/api:dev', plugin: dir, secrets: ['CLAUDE_CODE_OAUTH_TOKEN'] }
    const options = { cwd: dir, env, extendEnv: false }
    const argv = dockerArgs('awaywork-1', box, 'claude', ['-p', 'fix it'], options)
    delete process.env.AWAYWORK_UNCHANGED
    vi.unstubAllEnvs()
    const id = `${process.getuid?.()}:${process.getgid?.()}`
    expect(argv).toEqual([
      ...['run', '--rm', '--init', '--entrypoint=', '--user', id],
      ...['--cap-drop=ALL', '--security-opt=no-new-privileges', '-i', '--name', 'awaywork-1'],
      ...['-w', dir, '--mount', `type=bind,source=${dir},target=${dir}`],
      ...['--mount', `type=bind,source=${dir},target=${dir},readonly`],
      ...['-e', `HOME=${dir}/.away/home`],
      ...['-e', 'CLAUDE_CODE_OAUTH_TOKEN', '-e', 'GH_TOKEN', '-e', 'GIT_CONFIG_GLOBAL'],
      ...['-e', 'GIT_CONFIG_NOSYSTEM', '-e', 'ENABLE_CLAUDEAI_MCP_SERVERS'],
      ...['acme/api:dev', 'claude', '-p', 'fix it'],
    ])
    for (const value of ['sk-ant-canary', 'none', 'yours', '/Users/dev'])
      for (const arg of argv) expect(arg).not.toContain(value)
    const shell = dockerArgs('awaywork-2', { ...box, plugin: '/nonexistent' }, 'npm ci', [], {
      ...options,
      shell: true,
    })
    expect(shell.filter((arg) => arg === '--mount')).toHaveLength(1)
    expect(shell.slice(-4)).toEqual(['acme/api:dev', '/bin/sh', '-c', 'npm ci'])
  })

  it('names every variable awaywork sets in a phase’s env in AWAYWORK_ENV', async () => {
    const base = { PATH: '/usr/bin' }
    const phase = { ...job, env: workerEnv(base, dir, []) }
    await drain(claudeProvider(fake('claude')).run(phase, new AbortController().signal))
    const command = { command: 'true', secrets: [], skills_dir: '.agents/skills' }
    await drain(commandProvider('mine', command).run(phase, new AbortController().signal))
    await mkdir(join(dir, '.away'), { recursive: true })
    const envs = [
      commandEnv(base, dir, []),
      await gateEnv(base, dir, [], 'abc123', 'abc123'),
      ...vi.mocked(launch).mock.calls.map(([, , o]) => o.env),
    ]
    const set = envs.flatMap((env) => Object.keys(env ?? {})).filter((name) => !(name in base))
    expect(new Set(set)).toEqual(new Set(AWAYWORK_ENV))
  })

  // Where the worker user exists, real-isolation.test.ts takes the other side.
  it.skipIf(process.env.AWAYWORK_WORKER_TEST)(
    'isolates under isolation: user or on a GitHub-hosted runner, and refuses without the worker user',
    async () => {
      expect(await workerFor('none', { RUNNER_ENVIRONMENT: 'self-hosted' })).toBeUndefined()
      expect(await workerFor('none', {})).toBeUndefined()
      const refused =
        process.platform === 'linux'
          ? "can't run as the awaywork user"
          : `isolation: user runs on Linux only, not ${process.platform}`
      await expect(workerFor('none', { RUNNER_ENVIRONMENT: 'github-hosted' })).rejects.toThrow(
        refused,
      )
      await expect(workerFor('user', { RUNNER_ENVIRONMENT: 'self-hosted' })).rejects.toThrow(
        refused,
      )
    },
  )
})
