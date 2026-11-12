import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execa } from 'execa'
import { expect, it } from 'vitest'
import { parseConfig } from '../src/config/load.js'
import { bin } from '../src/config/paths.js'
import { allowance } from '../src/core/budget.js'
import type { Source, Unit } from '../src/core/types.js'
import { cursor } from '../src/providers/cursor.js'
import { workerEnv } from '../src/worker/env.js'
import { runWorker } from '../src/worker/run.js'
import { prepareWorkspace } from '../src/worker/workspace.js'
import { fakeForge } from './fakes/forge.js'
import { fakeItem } from './fakes/items.js'
import { fakeSource } from './fakes/source.js'

const git = (dir: string, ...args: string[]) =>
  execa(bin('git'), ['-C', dir, '-c', 'user.name=t', '-c', 'user.email=t@t', ...args])

/** Spends a few turns of the real plan; run with AWAYWORK_REAL=1 and CURSOR_API_KEY. */
it.skipIf(!process.env.AWAYWORK_REAL)(
  'runs the real agent binary through a unit',
  async () => {
    const root = await mkdtemp(join(tmpdir(), 'awaywork-real-cursor-'))
    const dir = join(root, 'clone')
    const plugin = join(root, 'plugin')
    const forge = {
      ...fakeForge(),
      async clone(_repo: string, _branch: string, into: string) {
        await mkdir(into)
        await execa(bin('git'), ['init', '-q', '-b', 'main', into])
        await writeFile(join(into, 'hello.txt'), 'helo wrld\n')
        await git(into, 'add', '.')
        await git(into, 'commit', '-qm', 'init')
      },
    }
    const config = parseConfig(
      'providers: [cursor]\nrepos: { acme/*: {} }\nsources: { github: {} }',
    )
    const item = fakeItem({ type: 'issue', title: 'Fix the typos in hello.txt' })
    const unit: Unit = {
      id: 'fake-1',
      items: [item],
      repo: 'acme/api',
      base: '',
      foreign: false,
      untrusted: false,
      branch: 'away/fake-1',
      rule: { skill: 'implement', provider: [], skills: [], instructions: [] },
      skill: 'implement',
      skills: [],
      providers: ['cursor'],
      instructions: [],
      deliver: 'draft_pr',
    }
    const ctx = { env: process.env, log: console.log }
    const prompt = await prepareWorkspace({
      unit,
      dir,
      plugin,
      config,
      configDir: dir,
      forge,
      sources: { fake: fakeSource() as Source },
      provider: cursor,
      ctx,
    })
    const job = { unit, dir, plugin, prompt, maxTurns: 12, env: workerEnv(process.env, dir, []) }
    const a = allowance(config.budget, null, Date.now(), config.windows)
    const result = await runWorker(cursor, job, a, { log: console.log })

    expect(result.status).toBe('done')
    expect(await readFile(join(dir, 'hello.txt'), 'utf8')).toMatch(/hello world/)
    expect(await readFile(join(dir, '.away/out/pr.md'), 'utf8')).not.toBe('')
    expect((await git(dir, 'status', '--porcelain')).stdout).toBe('')
    expect(existsSync(join(dir, '.away/agent-home/.cursor/cli-config.json'))).toBe(true)
  },
  300_000,
)
