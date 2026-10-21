import { existsSync } from 'node:fs'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execa } from 'execa'
import { expect, it } from 'vitest'
import { parseConfig } from '../src/config/load.js'
import { bin, builtinSkillsDir } from '../src/config/paths.js'
import { allowance } from '../src/core/budget.js'
import { planRun } from '../src/core/foreman.js'
import { containerize } from '../src/core/launch.js'
import { builtinSkills } from '../src/core/skills.js'
import type { Provider, PrRef } from '../src/core/types.js'
import { type Exec, exec } from '../src/forge/gh.js'
import { githubForge } from '../src/forge/github.js'
import { replayUnit } from '../src/worker/replay.js'
import { runUnits } from '../src/worker/units.js'
import { fakeForge } from './fakes/forge.js'
import { githubPr } from './fakes/items.js'
import { fakeProvider } from './fakes/provider.js'
import { fakeSource } from './fakes/source.js'

const git = (dir: string, ...args: string[]) =>
  execa(bin('git'), ['-C', dir, '-c', 'user.name=t', '-c', 'user.email=t@t', ...args])

/** A past run of one `fix` unit on acme/api, with `extra` config, for a replay to rebuild. */
async function pastRun(extra = '') {
  const root = await mkdtemp(join(tmpdir(), 'awaywork-replay-'))
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
      await writeFile(join(job.dir, '.away/out/pr.md'), 'Fix\n\nBody')
      yield { type: 'done', ok: true, turns: 1 }
    },
  }
  const config = parseConfig(`
providers: [claude]
sources: { github: { repos: [acme/*] } }
queue:
  - { skill: fix, where: { checks: failing } }
${extra}`)
  const quota = {
    windows: [
      { name: 'five_hour', span: 'short' as const, used: 0.1, resetsAt: 1790254200 },
      { name: 'seven_day', span: 'long' as const, used: 0.3, resetsAt: 1790391600 },
    ],
  }
  const now = 1790391600 * 1000 - 3 * 24 * 60 * 60 * 1000
  const plan = planRun({
    config,
    items: [githubPr(1, { checks: 'failing' })],
    allowances: { claude: allowance(config.budget, quota, now, config.windows) },
    skills: { builtin: builtinSkills },
  })
  const runDir = join(root, 'run')
  const skillDirs = { user: join(root, 'none'), builtin: builtinSkillsDir }
  const providers = { claude: worker }
  const ctx = { env: { PATH: process.env.PATH }, log: () => {} }
  const watch = () => ({ stop: async () => {} })
  const shared = { config, configDir: root, runDir, providers, forge, ctx, watch, skillDirs }
  const report = await runUnits({
    ...shared,
    plan,
    runId: '20260925-010000',
    dryRun: false,
    sources: { github: fakeSource() },
  })
  expect(report.results.map((u) => u.status)).toEqual(['done'])
  return { root, origin, forge, prompts, replay: { ...shared, unitId: 'acme-api-1', sources: {} } }
}

it('replays a unit on its base commit and saved context, and publishes nothing', async () => {
  const { origin, forge, prompts, replay } = await pastRun()
  const base = (await git(origin, 'rev-parse', 'HEAD')).stdout
  await git(origin, 'commit', '-q', '--allow-empty', '-m', 'moved on')
  const pushed = new Set(forge.branches)

  const result = await replayUnit(replay)

  expect(result.status).toBe('done')
  expect(result.commits).toBe(1)
  expect((await git(result.dir, 'rev-parse', 'HEAD~1')).stdout).toBe(base)
  expect((await git(result.dir, 'branch', '--show-current')).stdout).toBe('away/acme-api-1')
  expect(existsSync(join(result.dir, '.away/context/acme-api-1'))).toBe(true)
  expect(await readFile(join(result.out, 'pr.md'), 'utf8')).toMatch(/^Fix/)
  expect(prompts).toHaveLength(2)
  expect(forge.branches).toEqual(pushed)
})

it('replays in a container of the repo’s image under isolation: container, and needs one', async () => {
  const { root, replay } = await pastRun(
    "repos: { acme/api: { image: acme/api:dev, setup: 'true' } }",
  )
  const calls = join(root, 'docker.log')
  await writeFile(join(root, 'docker'), `#!/bin/sh\necho "$*" >> ${calls}\n`, { mode: 0o755 })
  const path = process.env.PATH
  process.env.PATH = `${root}:${path}`
  containerize(true)
  try {
    const result = await replayUnit(replay)
    const log = await readFile(calls, 'utf8')
    expect(log).toContain(`--mount type=bind,source=${result.dir},target=${result.dir}`)
    expect(log).toMatch(/ acme\/api:dev \/bin\/sh -c true\n/)
    const bare = { ...replay, config: { ...replay.config, repos: {} } }
    await expect(replayUnit(bare)).rejects.toThrow(
      'no image for acme/api: isolation: container needs one in its repos entry',
    )
  } finally {
    containerize(false)
    process.env.PATH = path
  }
})

it('replays a fork unit on its saved commit after the PR moved', async () => {
  const root = await mkdtemp(join(tmpdir(), 'awaywork-replay-'))
  const [work, origin] = [join(root, 'work'), join(root, 'origin')]
  await execa(bin('git'), ['init', '-q', '-b', 'main', work])
  await git(work, 'commit', '-q', '--allow-empty', '-m', 'fork main')
  const head = (await git(work, 'rev-parse', 'HEAD')).stdout
  await execa(bin('git'), ['clone', '-q', '--bare', work, origin])
  await git(origin, 'update-ref', 'refs/pull/3/head', head)
  const run: Exec = (cmd, args) =>
    exec(
      cmd,
      args.map((a) => (a === 'https://github.com/acme/api.git' ? origin : a)),
    )
  const forge = { ...fakeForge(), clone: githubForge(run).clone }
  const prompts: string[] = []
  const worker: Provider = {
    ...fakeProvider('claude'),
    async *run(job) {
      prompts.push(job.prompt)
      await writeFile(join(job.dir, '.away/out/report.md'), 'Looks fine')
      yield { type: 'done', ok: true, turns: 1 }
    },
  }
  const config = parseConfig(`
providers: [claude]
sources: { github: { repos: [acme/*] } }
queue: [{ skill: review }]
`)
  const forked = githubPr(3)
  const fork = { ...(forked.linkedPrs[0] as PrRef), branch: 'main', head, fork: true }
  const quota = {
    windows: [
      { name: 'five_hour', span: 'short' as const, used: 0.1, resetsAt: 1790254200 },
      { name: 'seven_day', span: 'long' as const, used: 0.3, resetsAt: 1790391600 },
    ],
  }
  const now = 1790391600 * 1000 - 3 * 24 * 60 * 60 * 1000
  const plan = planRun({
    config,
    items: [{ ...forked, linkedPrs: [fork] }],
    allowances: { claude: allowance(config.budget, quota, now, config.windows) },
    skills: { builtin: builtinSkills },
  })
  const shared = {
    config,
    configDir: root,
    runDir: join(root, 'run'),
    providers: { claude: worker },
    forge,
    ctx: { env: { PATH: process.env.PATH }, log: () => {} },
    watch: () => ({ stop: async () => {} }),
    skillDirs: { user: join(root, 'none'), builtin: builtinSkillsDir },
  }
  const report = await runUnits({
    ...shared,
    plan,
    runId: '20260925-010000',
    dryRun: false,
    sources: { github: fakeSource() },
  })
  expect(report.results.map((u) => u.status)).toEqual(['done'])
  await git(work, 'commit', '-q', '--allow-empty', '-m', 'moved on')
  await git(work, 'push', '-q', origin, 'main:refs/pull/3/head')

  const unitId = plan.units[0]?.unit.id ?? ''
  const result = await replayUnit({ ...shared, unitId, sources: {} })

  expect(result.status).toBe('done')
  expect((await git(result.dir, 'rev-parse', 'HEAD')).stdout).toBe(head)
  expect(prompts[1]).toContain('cut from #3 (from a fork).')
})

it('says a unit from before replay existed cannot be replayed', async () => {
  const root = await mkdtemp(join(tmpdir(), 'awaywork-replay-'))
  await expect(
    replayUnit({ runDir: root, unitId: 'x' } as Parameters<typeof replayUnit>[0]),
  ).rejects.toThrow(/no replay.json/)
})
