import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execa } from 'execa'
import { expect, it } from 'vitest'
import { parseConfig } from '../src/config/load.js'
import { allowance } from '../src/core/budget.js'
import type { Source, Unit } from '../src/core/types.js'
import { claude } from '../src/providers/claude.js'
import { runWorker } from '../src/worker/run.js'
import { prepareWorkspace } from '../src/worker/workspace.js'
import { fakeForge } from './fakes/forge.js'
import { fakeItem } from './fakes/items.js'
import { fakeSource } from './fakes/source.js'

const git = (dir: string, ...args: string[]) =>
  execa('git', ['-C', dir, '-c', 'user.name=t', '-c', 'user.email=t@t', ...args])

/** Spends a few turns of the real subscription; run with NIGHTSHIFT_REAL=1. */
it.skipIf(!process.env.NIGHTSHIFT_REAL)(
  'runs the real claude binary through a unit',
  async () => {
    const dir = join(await mkdtemp(join(tmpdir(), 'nightshift-real-')), 'clone')
    const forge = {
      ...fakeForge(),
      async clone(_repo: string, _branch: string, into: string) {
        await mkdir(into)
        await execa('git', ['init', '-q', '-b', 'main', into])
        await writeFile(join(into, 'hello.txt'), 'helo wrld\n')
        await git(into, 'add', '.')
        await git(into, 'commit', '-qm', 'init')
      },
    }
    const config = parseConfig('providers: [claude: {}]\nsources: { github: { repos: [acme/*] } }')
    const item = fakeItem({ type: 'issue', title: 'Fix the typos in hello.txt' })
    const unit: Unit = {
      id: 'fake-1',
      items: [item],
      repo: 'acme/api',
      base: '',
      branch: 'night/fake-1',
      rule: { skill: 'implement', where: {}, provider: [], skills: [], instructions: [] },
      skill: 'implement',
      skills: [],
      providers: ['claude'],
      instructions: [],
      deliver: 'draft_pr',
    }
    const ctx = { env: process.env, log: console.log }
    const sources = { fake: fakeSource() as Source }
    const prompt = await prepareWorkspace({
      unit,
      dir,
      config,
      configDir: dir,
      forge,
      sources,
      provider: claude,
      ctx,
    })
    const quota = await claude.probe(ctx)
    expect(quota?.windows.map((w) => w.span)).toEqual(['short', 'long'])

    const job = { unit, dir, prompt, maxTurns: 12 }
    const result = await runWorker(claude, job, allowance(config.budget, quota, Date.now()), {
      log: console.log,
    })

    expect(result.status).toBe('done')
    expect(await readFile(join(dir, 'hello.txt'), 'utf8')).toMatch(/hello world/)
    expect(await readFile(join(dir, '.nightshift/out/pr.md'), 'utf8')).not.toBe('')
    expect((await git(dir, 'status', '--porcelain')).stdout).toBe('')
  },
  300_000,
)
