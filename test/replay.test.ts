import { existsSync } from 'node:fs'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execa } from 'execa'
import { expect, it } from 'vitest'
import { parseConfig } from '../src/config/load.js'
import { bin, builtinSkillsDir } from '../src/config/paths.js'
import { allowance } from '../src/core/budget.js'
import { planNight } from '../src/core/foreman.js'
import { builtinSkills } from '../src/core/skills.js'
import type { Provider } from '../src/core/types.js'
import { runNight } from '../src/worker/night.js'
import { replayUnit } from '../src/worker/replay.js'
import { fakeForge } from './fakes/forge.js'
import { githubPr } from './fakes/items.js'
import { fakeProvider } from './fakes/provider.js'
import { fakeSource } from './fakes/source.js'

const git = (dir: string, ...args: string[]) =>
  execa(bin('git'), ['-C', dir, '-c', 'user.name=t', '-c', 'user.email=t@t', ...args])

it('replays a unit on its base commit and saved context, and publishes nothing', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nightshift-replay-'))
  const origin = join(root, 'origin')
  await execa(bin('git'), ['init', '-q', '-b', 'main', origin])
  await git(origin, 'commit', '-q', '--allow-empty', '-m', 'init')
  await git(origin, 'branch', 'feature-1')
  const forge = {
    ...fakeForge(),
    clone: async (_repo: string, branch: string, dir: string) => {
      await execa(bin('git'), ['clone', '-q', '--branch', branch, origin, dir])
    },
  }
  const prompts: string[] = []
  const worker: Provider = {
    ...fakeProvider('claude'),
    async *run(job) {
      prompts.push(job.prompt)
      await writeFile(join(job.dir, 'fix.txt'), 'fixed')
      await git(job.dir, 'add', 'fix.txt')
      await git(job.dir, 'commit', '-qm', 'Fix the build')
      await writeFile(join(job.dir, '.nightshift/out/pr.md'), 'Fix\n\nBody')
      yield { type: 'done', ok: true, turns: 1 }
    },
  }
  const config = parseConfig(`
providers: [claude]
sources: { github: { repos: [acme/*] } }
queue:
  - { skill: fix-ci, where: { checks: failing } }
`)
  const quota = {
    windows: [
      { name: 'five_hour', span: 'short' as const, used: 0.1, resetsAt: 1790254200 },
      { name: 'seven_day', span: 'long' as const, used: 0.3, resetsAt: 1790391600 },
    ],
  }
  const now = 1790391600 * 1000 - 3 * 24 * 60 * 60 * 1000
  const plan = planNight({
    config,
    items: [githubPr(1, { checks: 'failing' })],
    allowances: { claude: allowance(config.budget, quota, now) },
    skills: { builtin: builtinSkills },
  })
  const runDir = join(root, 'run')
  const skillDirs = { user: join(root, 'none'), builtin: builtinSkillsDir }
  const providers = { claude: worker }
  const ctx = { env: { PATH: process.env.PATH }, log: () => {} }
  const night = await runNight({
    config,
    configDir: root,
    plan,
    runId: '20260925-010000',
    runDir,
    dryRun: false,
    providers,
    sources: { github: fakeSource() },
    forge,
    ctx,
    watch: () => ({ stop: async () => {} }),
    skillDirs,
  })
  expect(night.results.map((u) => u.status)).toEqual(['done'])
  const base = (await git(origin, 'rev-parse', 'HEAD')).stdout
  await git(origin, 'commit', '-q', '--allow-empty', '-m', 'moved on')
  const pushed = new Set(forge.branches)

  const result = await replayUnit({
    config,
    configDir: root,
    runDir,
    unitId: 'acme-api-1',
    providers,
    sources: {},
    forge,
    ctx,
    watch: () => ({ stop: async () => {} }),
    skillDirs,
  })

  expect(result.status).toBe('done')
  expect(result.commits).toBe(1)
  expect((await git(result.dir, 'rev-parse', 'HEAD~1')).stdout).toBe(base)
  expect((await git(result.dir, 'branch', '--show-current')).stdout).toBe('night/acme-api-1')
  expect(existsSync(join(result.dir, '.nightshift/context/acme-api-1'))).toBe(true)
  expect(await readFile(join(result.out, 'pr.md'), 'utf8')).toMatch(/^Fix/)
  expect(prompts).toHaveLength(2)
  expect(forge.branches).toEqual(pushed)
})

it('says a unit from before replay existed cannot be replayed', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nightshift-replay-'))
  await expect(
    replayUnit({ runDir: root, unitId: 'x' } as Parameters<typeof replayUnit>[0]),
  ).rejects.toThrow(/no replay.json/)
})
