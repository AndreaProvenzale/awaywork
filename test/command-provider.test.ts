import { mkdir, mkdtemp, realpath, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { describeAllowance } from '../src/cli/format.js'
import { ConfigError, parseConfig } from '../src/config/load.js'
import type { Job, WorkerEvent } from '../src/core/types.js'
import { commandProvider } from '../src/providers/command.js'
import { providerFor, providersOf } from '../src/providers/index.js'
import { providerContract } from './contracts/provider.contract.js'

// realpath: macOS's tmpdir is a symlink, and `pwd` prints the resolved path.
const tmp = await realpath(await mkdtemp(join(tmpdir(), 'awaywork-command-provider-')))
await mkdir(join(tmp, '.away'))
await writeFile(join(tmp, '.away', 'prompt.md'), 'fix it')

const base = `
sources: { github: { repos: [acme/api] } }
limits: { unit_minutes: 30 }
`
const config = (entry: string, extra = base) => `providers: [claude, ${entry}]\n${extra}`

function problems(text: string): string[] {
  try {
    parseConfig(text)
    return []
  } catch (e) {
    if (e instanceof ConfigError) return e.problems
    throw e
  }
}

const cfg = (over: object = {}) => ({
  command: 'true',
  secrets: [],
  skills_dir: '.agents/skills',
  dir: tmp,
  ...over,
})

const job = (): Job =>
  ({ dir: tmp, prompt: 'fix it', maxTurns: 1, env: { PATH: process.env.PATH } }) as unknown as Job

async function collect(events: AsyncIterable<WorkerEvent>): Promise<WorkerEvent[]> {
  const all: WorkerEvent[] = []
  for await (const e of events) all.push(e)
  return all
}

// Its config is its command, and it installs nothing: the CLI is your own.
providerContract(commandProvider('x', cfg()), job, ['emptyConfig', 'package'])

describe('command provider config', () => {
  it('takes a name of your own with a command and budget', () => {
    const parsed = parseConfig(
      config(
        'opencode: { command: opencode run, secrets: [OPENCODE_API_KEY], budget: { reserve: 5% } }',
      ),
    )
    expect(parsed.providers.map((p) => p.id)).toEqual(['claude', 'opencode'])
    const opencode = parsed.providers[1]
    expect(opencode?.config).toMatchObject({
      command: 'opencode run',
      secrets: ['OPENCODE_API_KEY'],
      skills_dir: '.agents/skills',
    })
    expect(Object.keys(providersOf(parsed))).toContain('opencode')
  })

  it('needs a command, and a bare name stays unknown', () => {
    expect(problems(config('opencode: {}'))).toEqual([
      'providers[1]: opencode.command: not a built-in provider; a custom provider needs a `command`',
    ])
    expect(problems(config('opencode'))).toEqual([
      expect.stringContaining('unknown provider "opencode"'),
    ])
  })

  it('names the path of a nested problem', () => {
    expect(problems(config('opencode: { command: x, budget: { reserve: 5 } }'))).toEqual([
      expect.stringMatching(/^providers\[1\]: opencode\.budget\.reserve: /),
    ])
  })

  it('takes a fallback without turns', () => {
    const parsed = parseConfig(
      config('opencode: { command: x, budget: { fallback: { units: 2 } } }'),
    )
    expect(parsed.providers[1]?.budget.fallback).toEqual({ units: 2, turns: 60 })
  })

  it('describes its fallback without turns', () => {
    const a = { kind: 'fallback', units: 4, turns: 60, reason: 'no quota reading' } as const
    expect(describeAllowance('opencode', a)).toBe('fallback: 4 units (no quota reading)')
    expect(describeAllowance('codex', a)).toBe(
      'fallback: 4 units, 60 turns each (no quota reading)',
    )
  })

  it('refuses a name that is not a plain lowercase word', () => {
    const text = config('toString: { command: x }')
    expect(problems(text)).toEqual([
      'providers[1].toString: expected a lowercase name like opencode',
    ])
    expect(providerFor('toString', undefined)).toBeUndefined()
    expect(problems(config('constructor: { command: x }'))).toEqual([
      'providers[1].constructor: expected a lowercase name like opencode',
    ])
  })

  it('requires limits.unit_minutes, since there is no turn cap', () => {
    expect(
      problems(
        config('opencode: { command: opencode }', base.replace('limits: { unit_minutes: 30 }', '')),
      ),
    ).toEqual([expect.stringMatching(/^limits\.unit_minutes: required/)])
  })
})

describe('command provider', () => {
  it('runs the command in the clone with the prompt file named, output as log lines', async () => {
    const p = commandProvider(
      'x',
      cfg({ command: 'echo "$AWAYWORK_PROMPT"; pwd; sleep 0.2; echo oops >&2' }),
    )
    const events = await collect(p.run(job(), new AbortController().signal))
    expect(events).toEqual([
      { type: 'log', line: join(tmp, '.away', 'prompt.md') },
      { type: 'log', line: tmp },
      { type: 'log', line: 'oops' },
      { type: 'done', ok: true, turns: 0 },
    ])
  })

  it('fails the unit on a non-zero exit', async () => {
    const p = commandProvider('x', cfg({ command: 'exit 3' }))
    const events = await collect(p.run(job(), new AbortController().signal))
    expect(events.at(-1)).toEqual({ type: 'done', ok: false, turns: 0 })
  })

  it('has no quota without a probe, and reads Quota as is from one', async () => {
    const ctx = { env: { PATH: process.env.PATH }, log: () => {} }
    expect(await commandProvider('x', cfg()).probe(ctx)).toBeNull()
    const quota = { windows: [{ name: '5h', span: 'short', used: 0.2, resetsAt: 1793021152 }] }
    const ok = commandProvider('x', cfg({ probe: `echo '${JSON.stringify(quota)}'` }))
    expect(await ok.probe(ctx)).toEqual(quota)
    await expect(commandProvider('x', cfg({ probe: 'echo nope' })).probe(ctx)).rejects.toThrow(
      'did not print JSON',
    )
  })

  it('probes again after the unit, so the budget sees what it used', async () => {
    const quota = { windows: [{ name: 'week', span: 'long', used: 0.4, resetsAt: 1793021152 }] }
    const p = commandProvider('x', cfg({ probe: `echo '${JSON.stringify(quota)}'` }))
    const events = await collect(p.run(job(), new AbortController().signal))
    expect(events).toEqual([
      { type: 'quota', quota },
      { type: 'done', ok: true, turns: 0 },
    ])
  })

  it('stops a probe at its timeout, with whatever it started', async () => {
    const ctx = { env: { PATH: process.env.PATH }, log: () => {} }
    const p = commandProvider('x', cfg({ probe: 'sleep 20 & sleep 30' }), 200)
    const started = Date.now()
    await expect(p.probe(ctx)).rejects.toThrow(/timed out/)
    expect(Date.now() - started).toBeLessThan(5000)
  })

  it("isn't available on a GitHub-hosted runner", () => {
    const p = commandProvider('x', cfg())
    expect(p.unavailable?.({ RUNNER_ENVIRONMENT: 'github-hosted' })).toMatch(/self-hosted/)
    expect(p.unavailable?.({ RUNNER_ENVIRONMENT: 'self-hosted' })).toBeUndefined()
  })

  it('detects whether the command exists', async () => {
    expect(await commandProvider('x', cfg({ command: 'sh -c true' })).detect()).toEqual({
      installed: true,
    })
    expect(await commandProvider('x', cfg({ command: 'no-such-agent-cli' })).detect()).toEqual({
      installed: false,
    })
  })

  it('skips leading env assignments when looking for the binary', async () => {
    expect(await commandProvider('x', cfg({ command: 'FOO=1 sh -c true' })).detect()).toEqual({
      installed: true,
    })
  })

  it('rejects a model', () => {
    expect(() => parseConfig(config('opencode: { command: opencode run, model: pro }'))).toThrow()
  })

  it('rejects a rule model for it', () => {
    const text = config(
      'opencode: { command: opencode run }',
      `${base}\nqueue:\n  - skill: review\n    model: { opencode: pro }\n`,
    )
    expect(problems(text).join('\n')).toContain('put it in its command')
  })

  it('refuses MCP servers on a rule or step it may run', () => {
    const queue = (rules: string) =>
      problems(
        config(
          'opencode: { command: opencode run }',
          `${base}mcp: { sentry: { url: 'https://mcp.sentry.dev/mcp' } }\nqueue:\n${rules}`,
        ),
      )
    expect(queue('  - { skill: fix, mcp: [sentry] }\n')).toEqual([
      'queue[0].mcp: the command provider "opencode" gets no MCP servers: route this step to another provider with `provider`',
    ])
    expect(
      queue('  - { skill: fix, mcp: [sentry], then: [{ skill: review, provider: opencode }] }\n'),
    ).toEqual([
      expect.stringMatching(/^queue\[0\]\.mcp: /),
      expect.stringMatching(/^queue\[0\]\.then\[0\]\.provider: /),
    ])
    expect(queue('  - { skill: fix, mcp: [sentry], provider: claude }\n')).toEqual([])
  })
})
