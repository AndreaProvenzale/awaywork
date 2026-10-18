import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { ConfigError, parseConfig } from '../src/config/load.js'
import type { Job, WorkerEvent } from '../src/core/types.js'
import { commandProvider } from '../src/providers/command.js'
import { providersOf } from '../src/providers/index.js'

const tmp = await mkdtemp(join(tmpdir(), 'awaywork-command-provider-'))
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
  instructions_file: 'AGENTS.md',
  dir: tmp,
  ...over,
})

const job = (): Job =>
  ({ dir: tmp, prompt: 'fix it', maxTurns: 1, env: { PATH: process.env.PATH } }) as Job

async function collect(events: AsyncIterable<WorkerEvent>): Promise<WorkerEvent[]> {
  const all: WorkerEvent[] = []
  for await (const e of events) all.push(e)
  return all
}

describe('command provider config', () => {
  it('takes a name of your own with a command and budget', () => {
    const parsed = parseConfig(
      config('gemini: { command: gemini -p, secrets: [GEMINI_API_KEY], budget: { reserve: 5% } }'),
    )
    expect(parsed.providers.map((p) => p.id)).toEqual(['claude', 'gemini'])
    const gemini = parsed.providers[1]
    expect(gemini?.config).toMatchObject({
      command: 'gemini -p',
      secrets: ['GEMINI_API_KEY'],
      skills_dir: '.agents/skills',
      instructions_file: 'AGENTS.md',
    })
    expect(Object.keys(providersOf(parsed))).toContain('gemini')
  })

  it('needs a command, and a bare name stays unknown', () => {
    expect(problems(config('gemini: {}'))).toEqual([expect.stringContaining('needs a `command`')])
    expect(problems(config('gemini'))).toEqual([
      expect.stringContaining('unknown provider "gemini"'),
    ])
  })

  it('requires limits.unit_minutes, since there is no turn cap', () => {
    expect(
      problems(
        config('gemini: { command: gemini }', base.replace('limits: { unit_minutes: 30 }', '')),
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
    expect(() => parseConfig(config('gemini: { command: gemini -p, model: pro }'))).toThrow()
  })
})
