import { existsSync } from 'node:fs'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execa } from 'execa'
import { expect, it } from 'vitest'
import { parseConfig } from '../src/config/load.js'
import { builtinSkillsDir } from '../src/config/paths.js'
import { allowance } from '../src/core/budget.js'
import { planNight } from '../src/core/foreman.js'
import { formatReport, summarize } from '../src/core/report.js'
import { builtinSkills } from '../src/core/skills.js'
import type { Provider, Quota, Source } from '../src/core/types.js'
import { runNight } from '../src/worker/night.js'
import { fakeForge } from './fakes/forge.js'
import { githubPr } from './fakes/items.js'
import { fakeProvider } from './fakes/provider.js'
import { fakeSource } from './fakes/source.js'

// publish amends commits, which needs a committer identity even on a bare CI runner
process.env.GIT_COMMITTER_NAME ??= 't'
process.env.GIT_COMMITTER_EMAIL ??= 't@t'

const git = (dir: string, ...args: string[]) =>
  execa('git', ['-C', dir, '-c', 'user.name=t', '-c', 'user.email=t@t', ...args])

const quota = (long: number): Quota => ({
  windows: [
    { name: 'five_hour', span: 'short', used: 0.1, resetsAt: 1790254200 },
    { name: 'seven_day', span: 'long', used: long, resetsAt: 1790391600 },
  ],
})

/** Commits and writes a PR body, or writes a report, as a model would; the week fills to 45%. */
const worker: Provider = {
  ...fakeProvider('claude'),
  async *run(job) {
    const out = join(job.dir, '.nightshift/out')
    if (job.unit.deliver === 'report') await writeFile(join(out, 'report.md'), 'Approve.')
    else {
      await writeFile(join(job.dir, 'fix.txt'), 'fixed')
      await git(job.dir, 'add', 'fix.txt')
      await git(job.dir, 'commit', '-qm', 'Fix the build')
      await writeFile(join(out, 'pr.md'), 'Fix the build\n\nRan the failing test.')
    }
    yield { type: 'log', line: 'working' }
    yield { type: 'quota', quota: quota(0.45) }
    yield { type: 'done', ok: true, turns: 5 }
  },
}

it('runs, publishes and reports a night', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nightshift-night-'))
  const origin = join(root, 'origin')
  await execa('git', ['init', '-q', '-b', 'main', origin])
  await git(origin, 'commit', '-q', '--allow-empty', '-m', 'init')
  for (const n of [1, 2, 3]) await git(origin, 'branch', `feature-${n}`)
  const forge = {
    ...fakeForge(),
    clone: async (_repo: string, branch: string, dir: string) => {
      await execa('git', ['clone', '-q', '--branch', branch, origin, dir])
    },
  }
  forge.branches.add('acme/api:night/acme-api-3')

  const config = parseConfig(`
providers: [claude: {}]
sources: { github: { repos: [acme/*] } }
queue:
  - { skill: fix-ci, where: { checks: failing } }
  - { skill: review, where: { review_requested: true } }
`)
  const items = [
    githubPr(1, { checks: 'failing' }),
    githubPr(2, { mine: false, review_requested: true }),
    githubPr(3, { checks: 'failing' }),
  ]
  const now = 1790391600 * 1000 - 3 * 24 * 60 * 60 * 1000
  const allowances = { claude: allowance(config.budget, quota(0.36), now) }
  const plan = planNight({ config, items, allowances, skills: { builtin: builtinSkills } })
  const runDir = join(root, 'run')

  const report = await runNight({
    config,
    configDir: root,
    plan,
    runId: '20260925-010000',
    runDir,
    dryRun: false,
    providers: { claude: worker },
    sources: { github: fakeSource() as Source },
    forge,
    ctx: { env: {}, log: () => {} },
    watch: () => ({ stop: async () => {} }),
    skillDirs: { user: join(root, 'none'), builtin: builtinSkillsDir },
  })

  expect(report.results.map((u) => [u.planned.unit.id, u.status, u.outcome ?? u.reason])).toEqual([
    [
      'acme-api-1',
      'done',
      { kind: 'pr', url: 'https://example.com/acme/api/pull/night/acme-api-1', commits: 1 },
    ],
    ['acme-api-3', 'skipped', 'night/acme-api-3 already exists on acme/api'],
    ['acme-api-2', 'done', { kind: 'report', text: 'Approve.' }],
  ])
  const unitDir = join(runDir, 'units', 'acme-api-1')
  expect(await readFile(join(unitDir, 'out/pr.md'), 'utf8')).toMatch(/^Fix the build/)
  expect(await readFile(join(unitDir, 'worker.log'), 'utf8')).toMatch(/Z working\n/)
  expect(existsSync(join(unitDir, 'prompt.md'))).toBe(true)
  expect(existsSync(join(unitDir, 'context/acme-api-1'))).toBe(true)
  expect(existsSync(join(runDir, 'work', 'acme-api-1'))).toBe(false)

  const text = formatReport(report)
  expect(text).toContain(
    '| 1 | acme-api-1 | fix-ci | claude | done, 5 turns | https://example.com/acme/api/pull/night/acme-api-1 (1 commits) |',
  )
  expect(text).toContain(
    '| 2 | acme-api-3 | fix-ci | - | skipped | night/acme-api-3 already exists on acme/api |',
  )
  expect(text).toContain(
    '- claude: seven_day 36% to 45%, ceiling 54%; session 10% to 10%, stop at 90%',
  )
  expect(text).toContain(
    '### acme-api-2: PR 2 (review)\n\nhttps://github.com/acme/api/pull/2\n\nApprove.',
  )
  expect(summarize(report, 'report.md').split('\n')[0]).toBe(
    'Run 20260925-010000: 1 draft PRs, 1 reports, 3 units',
  )
})

it('prepares workspaces without running a worker on a dry run, for one unit', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nightshift-dry-'))
  const forge = {
    ...fakeForge(),
    clone: async (_repo: string, _branch: string, dir: string) => {
      await execa('git', ['init', '-q', dir])
      await git(dir, 'commit', '-q', '--allow-empty', '-m', 'init')
    },
  }
  const config = parseConfig(
    'providers: [claude: {}]\nsources: { github: { repos: [acme/*] } }\nqueue: [{ skill: fix-ci }]',
  )
  const plan = planNight({
    config,
    items: [githubPr(1), githubPr(2)],
    allowances: { claude: allowance(config.budget, null, 0) },
    skills: { builtin: builtinSkills },
  })
  const input = {
    config,
    configDir: root,
    plan,
    runId: 'r1',
    runDir: join(root, 'run'),
    dryRun: true,
    providers: { claude: { ...worker, run: () => expect.fail('no worker on a dry run') } },
    sources: { github: fakeSource() as Source },
    forge,
    ctx: { env: {}, log: () => {} },
    skillDirs: { user: join(root, 'none'), builtin: builtinSkillsDir },
  }
  const report = await runNight({ ...input, only: 'acme-api-2' })
  expect(report.results.map((u) => [u.planned.unit.id, u.status])).toEqual([
    ['acme-api-2', 'prepared'],
  ])
  expect(existsSync(join(root, 'run/work/acme-api-2/.nightshift/prompt.md'))).toBe(true)
  for (const only of ['acme/api#2', 'ACME-API-2']) {
    const byKey = await runNight({ ...input, only })
    expect(byKey.results.map((u) => u.planned.unit.id)).toEqual(['acme-api-2'])
  }
  await expect(runNight({ ...input, only: 'nope' })).rejects.toThrow('no unit "nope"')

  const ended = await runNight({ ...input, until: new Date(0) })
  expect(ended.results.map((u) => u.reason)).toEqual([
    'the night window ended',
    'the night window ended',
  ])
})
