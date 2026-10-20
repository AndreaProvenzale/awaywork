import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execa } from 'execa'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { parseConfig } from '../src/config/load.js'
import { launch } from '../src/core/launch.js'
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
  return { launch: vi.fn(real.launch) }
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

  it('doesn’t start context commands, the config’s and not the repo’s', async () => {
    const context = { command: 'echo hi > "$AWAYWORK_CONTEXT_DIR/out.md"', secrets: [] }
    await fetchContexts([fakeItem({ source: 'github', key: 'ACME-1' })], dir, {
      config: parseConfig(
        `providers: [claude: {}]\nsources: { github: { repos: [acme/*], context: ${JSON.stringify(context)} } }`,
      ),
      configDir: dir,
      env,
      secrets: [],
      log: () => {},
    })
    expect(await readFile(join(dir, '.away/context/acme-1/extra/out.md'), 'utf8')).toBe('hi\n')
    expect(launched()).toEqual([])
  })
})
