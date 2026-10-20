import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execa } from 'execa'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { parseConfig } from '../src/config/load.js'
import {
  asWorker,
  isolate,
  launch,
  sudoArgs,
  sudoersLines,
  WORKER,
  workerFor,
  workerRoot,
} from '../src/core/launch.js'
import type { Job, Unit } from '../src/core/types.js'
import { claudeProvider } from '../src/providers/claude.js'
import { codexProvider } from '../src/providers/codex.js'
import { commandProvider } from '../src/providers/command.js'
import { createChecks } from '../src/worker/checks.js'
import { fetchContexts } from '../src/worker/context.js'
import { runSetup } from '../src/worker/setup.js'
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

  it('starts setup and the checks, not the parent’s git', async () => {
    await execa('git', ['init', '-q', dir])
    const commit = ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty']
    await execa('git', ['-C', dir, ...commit, '-m', 'start'])
    expect(await runSetup('true', dir, env, () => {}, { secrets: [] })).toBeUndefined()
    const { check, rememberGitConfig } = createChecks({ env, secrets: [] })
    rememberGitConfig(dir, await readFile(join(dir, '.git', 'config'), 'utf8'))
    const unit = { untrusted: false } as Unit
    expect((await check('exit 0', unit, dir, () => {}, false)).failed).toBeUndefined()
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

  it('chowns a clone only as the sudoers lines allow, a folder straight under /tmp', async () => {
    const fakes = await mkdtemp(join(tmpdir(), 'awaywork-sudo-'))
    const calls = join(fakes, 'calls')
    await writeFile(join(fakes, 'sudo'), `#!/bin/sh\necho "$*" >> ${calls}\n`, { mode: 0o755 })
    const path = process.env.PATH
    process.env.PATH = `${fakes}:${path}`
    isolate(WORKER)
    const clone = await workerRoot()
    try {
      await asWorker(clone, async () => {})
    } finally {
      isolate(undefined)
      process.env.PATH = path
      await rm(clone, { recursive: true, force: true })
    }
    const c = '[A-Za-z0-9]'.repeat(6)
    const [worker, root] = sudoersLines('dev')
    expect(worker).toBe('dev ALL=(awaywork) NOPASSWD:SETENV: ALL')
    const owner = `${process.getuid?.()}\\:${process.getgid?.()}`
    expect(root).toBe(
      `dev ALL=(root) NOPASSWD: /usr/bin/chown -R -h -P awaywork\\: /tmp/awaywork-${c}, /usr/bin/chown -R -h -P ${owner} /tmp/awaywork-${c}`,
    )
    // As sudoers matches these: `\:` is a colon, a class one character, the rest literal.
    const allowed = (root?.split('NOPASSWD: ')[1] ?? '').split(', ').map((command) => {
      const literal = command.replaceAll('\\:', ':').split('[A-Za-z0-9]')
      return new RegExp(
        `^${literal.map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('[A-Za-z0-9]')}$`,
      )
    })
    const chowns = (await readFile(calls, 'utf8'))
      .split('\n')
      .filter((call) => call.includes('chown'))
    expect(chowns).toHaveLength(2)
    for (const call of chowns)
      expect(allowed.some((rule) => rule.test(call.replace(/^-n /, '')))).toBe(true)
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
