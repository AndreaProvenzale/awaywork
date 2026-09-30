import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execa } from 'execa'
import { expect, it } from 'vitest'
import { parseConfig } from '../src/config/load.js'
import { allowance } from '../src/core/budget.js'
import type { Source, Unit } from '../src/core/types.js'
import { codex } from '../src/providers/codex.js'
import { runWorker } from '../src/worker/run.js'
import { prepareWorkspace, workerEnv } from '../src/worker/workspace.js'
import { fakeForge } from './fakes/forge.js'
import { fakeItem } from './fakes/items.js'
import { fakeSource } from './fakes/source.js'

const git = (dir: string, ...args: string[]) =>
  execa('git', ['-C', dir, '-c', 'user.name=t', '-c', 'user.email=t@t', ...args])

/** Spends a few turns of the real subscription; run with NIGHTSHIFT_REAL=1. */
it.skipIf(!process.env.NIGHTSHIFT_REAL)(
  'runs the real codex binary through a unit',
  async () => {
    const root = await mkdtemp(join(tmpdir(), 'nightshift-real-codex-'))
    const dir = join(root, 'clone')
    const plugin = join(root, 'plugin')
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
    const config = parseConfig('providers: [codex: {}]\nsources: { github: { repos: [acme/*] } }')
    const item = fakeItem({ type: 'issue', title: 'Fix the typos in hello.txt' })
    const unit: Unit = {
      id: 'fake-1',
      items: [item],
      repo: 'acme/api',
      base: '',
      foreign: false,
      untrusted: false,
      branch: 'night/fake-1',
      rule: { skill: 'implement', provider: [], skills: [], instructions: [] },
      skill: 'implement',
      skills: [],
      providers: ['codex'],
      instructions: [],
      deliver: 'draft_pr',
    }
    const ctx = { env: process.env, log: console.log }
    const sources = { fake: fakeSource() as Source }
    const prompt = await prepareWorkspace({
      unit,
      dir,
      plugin,
      config,
      configDir: dir,
      forge,
      sources,
      provider: codex,
      ctx,
    })
    const quota = await codex.probe(ctx)
    expect(quota?.windows.map((w) => w.span)).toContain('long')

    const job = { unit, dir, plugin, prompt, maxTurns: 12, env: workerEnv(process.env, dir, []) }
    const result = await runWorker(codex, job, allowance(config.budget, quota, Date.now()), {
      log: console.log,
    })

    // On the free plan one unit outspends the paced month, so the after-run reading can stop it.
    expect(['done', 'stopped: quota']).toContain(result.status)
    expect(await readFile(join(dir, 'hello.txt'), 'utf8')).toMatch(/hello world/)
    expect(await readFile(join(dir, '.nightshift/out/pr.md'), 'utf8')).not.toBe('')
    expect((await git(dir, 'status', '--porcelain')).stdout).toBe('')
  },
  300_000,
)
