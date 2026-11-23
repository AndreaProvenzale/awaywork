import { existsSync } from 'node:fs'
import { mkdtemp, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execa } from 'execa'
import { expect, it } from 'vitest'
import { parseConfig } from '#config/load'
import { bin, builtinSkillsDir } from '#config/paths'
import { setupOf } from '#config/skills'
import { builtinSkills } from '#core/skills'
import type { Provider, Source } from '#core/types'
import { formatReport } from '#format/report-md'
import { recordAttempts } from '#plan/attempts'
import { planRun } from '#plan/foreman'
import { type Allowance, allowance } from '#quota/budget'
import { unitStats } from '#run/stats'
import { runUnits } from '#worker/units/run'
import { withRepos } from './fakes/acme'
import { fakeForge } from './fakes/forge'
import { githubPr } from './fakes/items'
import { fakeSource } from './fakes/source'
import { git, quota, reset, worker } from './fakes/units'

const retryRule = '{ skill: fix, where: { checks: failing }, model: { claude: [sonnet, opus] } }'

const sonnetWeek = {
  name: 'seven_day_sonnet',
  span: 'long',
  used: 0.95,
  resetsAt: reset,
  scoped: true,
} as const
/** Room on the week every model counts, under a ceiling of 80% on a model's own. */
const roomy: Allowance = {
  kind: 'quota',
  window: 'seven_day',
  used: 0.36,
  resetsAt: reset,
  ceiling: 0.8,
  runs: 3,
  limits: [
    { name: 'reserve', value: 0.9 },
    { name: 'pacing', value: 0.8 },
  ],
}

/**
 * Runs one PR's rule with a provider that does `act(skill, model)`: a failing run first leaves partial
 * work behind (`burn` also uses quota), `full` fills sonnet's own week, and `leave` succeeds but leaves an uncommitted file and an extra `out/` file;
 * `swap` fails with a report, its `.away/out` swapped for a symlink.
 */
async function retried(
  act: (
    skill: string,
    model?: string,
  ) => 'ok' | 'fail' | 'burn' | 'quota' | 'full' | 'leave' | 'swap',
  rule = retryRule,
  claude?: Allowance,
  repos = '',
) {
  const root = await mkdtemp(join(tmpdir(), 'awaywork-retry-'))
  const origin = join(root, 'origin')
  await execa(bin('git'), ['init', '-q', '-b', 'main', origin])
  await writeFile(join(origin, 'tracked.txt'), 'orig')
  await git(origin, 'add', 'tracked.txt')
  await git(origin, 'commit', '-q', '-m', 'init')
  await git(origin, 'branch', 'feature-1')
  const forge = {
    ...fakeForge(),
    clone: async (_repo: string, branch: string, dir: string) => {
      await execa(bin('git'), ['clone', '-q', '--branch', branch, origin, dir])
    },
  }
  const tried: string[] = []
  const logs: string[] = []
  // What each run found in the clone: the files a failing run leaves, and the PR body.
  const found: string[] = []
  const tracked: string[] = []
  const flaky: Provider = {
    ...worker,
    async *run(job) {
      const { skill } = job.unit
      tried.push(`${skill} ${job.model}`)
      const files = [
        'fix.txt',
        'partial.txt',
        'junk.txt',
        'gen.txt',
        'leftover.txt',
        '.away/out/notes.md',
        '.away/context/previous/when.log',
      ].filter((f) => existsSync(join(job.dir, f)))
      const body = await readFile(join(job.dir, '.away/out/pr.md'), 'utf8').catch(() => '')
      found.push(`${skill}: ${files.join(' ')} | ${body}`)
      tracked.push(await readFile(join(job.dir, 'tracked.txt'), 'utf8'))
      const does = act(skill, job.model)
      if (does === 'burn') yield { type: 'quota', quota: quota(0.45) }
      if (does === 'fail' || does === 'burn') {
        await writeFile(join(job.dir, 'partial.txt'), 'half')
        await git(job.dir, 'add', 'partial.txt')
        await git(job.dir, 'commit', '-qm', 'Half a fix')
        await writeFile(join(job.dir, 'junk.txt'), 'junk')
        await writeFile(join(job.dir, 'tracked.txt'), 'broken')
        await rm(join(job.dir, 'gen.txt'), { force: true })
        await rm(join(job.dir, '.away/out/notes.md'), { force: true })
        await writeFile(join(job.dir, '.away/out/pr.md'), 'Half a fix')
        yield { type: 'done', ok: false, turns: 3 }
        return
      }
      if (does === 'swap') {
        const elsewhere = await mkdtemp(join(tmpdir(), 'awaywork-out-'))
        await writeFile(join(elsewhere, 'report.md'), 'Half a review.')
        await rm(join(job.dir, '.away/out'), { recursive: true })
        await symlink(elsewhere, join(job.dir, '.away/out'))
        yield { type: 'done', ok: false, turns: 3 }
        return
      }
      if (does === 'leave') {
        await writeFile(join(job.dir, 'leftover.txt'), 'uncommitted')
        await writeFile(join(job.dir, '.away/out/notes.md'), 'notes')
      }
      if (does === 'quota') {
        yield { type: 'quota', quota: quota(0.99) }
        return
      }
      if (does === 'full') {
        yield { type: 'quota', quota: { windows: [...quota(0.4).windows, sonnetWeek] } }
        return
      }
      yield* worker.run(job, new AbortController().signal)
    },
  }
  const config = parseConfig(`
providers: [claude]
sources: { github: {} }
queue:
  - ${rule}
${withRepos(repos)}
`)
  const now = reset * 1000 - 3 * 24 * 60 * 60 * 1000
  const allowances = {
    claude: claude ?? allowance(config.budget, quota(0.36), now, config.windows),
  }
  const plan = planRun({
    setup: setupOf(config, { builtin: builtinSkills }),
    items: [githubPr(1, { checks: 'failing', updated: '2026-09-01T00:00:00Z' })],
    allowances,
  })
  const runDir = join(root, 'run')
  const report = await runUnits({
    config,
    configDir: root,
    plan,
    runId: '20260925-010000',
    runDir,
    dryRun: false,
    providers: { claude: flaky },
    sources: { github: fakeSource() as Source },
    forge,
    ctx: { env: { PATH: '/bin' }, log: (line) => logs.push(line) },
    watch: () => ({ stop: async () => {} }),
    shortage: async () => undefined,
    skillDirs: { user: join(root, 'none'), builtin: builtinSkillsDir },
  })
  const failed = recordAttempts({}, report)['github:acme/api#1']?.failed
  const units = join(runDir, 'units', 'acme-api-1')
  return { tried, logs, found, tracked, report, failed, units }
}

it('runs a failed step once on a single model', async () => {
  const { tried, report, failed } = await retried(
    () => 'fail',
    '{ skill: fix, where: { checks: failing }, model: { claude: sonnet } }',
  )
  expect(tried).toEqual(['fix sonnet'])
  expect(report.results.map((u) => [u.status, u.retried])).toEqual([['failed', undefined]])
  expect(failed).toBe(1)
})

it('retries a failed step once on the next model', async () => {
  const { tried, logs, report, failed } = await retried((_, model) =>
    model === 'sonnet' ? 'fail' : 'ok',
  )
  expect(tried).toEqual(['fix sonnet', 'fix opus'])
  expect(logs).toContain('acme-api-1: failed, retrying on opus')
  expect(report.results.map((u) => [u.step, u.status, u.retried, u.outcome?.kind])).toEqual([
    ['1-fix', 'failed', true, undefined],
    ['2-fix', 'done', undefined, 'pr'],
  ])
  expect(report.results[1]?.outcome).toMatchObject({ commits: 1 })
  expect(formatReport(report)).toContain('| failed, 3 turns (retried on the next model) |')
  expect(failed).toBeUndefined()
  expect(unitStats(report.results).map((s) => s.status)).toEqual(['failed', 'done'])
})

it("retries only a chain's failed step, keeping the steps before it", async () => {
  const { tried, found, report, failed } = await retried(
    (skill, model) => (skill === 'review' && model === 'sonnet' ? 'fail' : 'ok'),
    '{ skill: fix, where: { checks: failing }, model: { claude: [sonnet, opus] }, then: review }',
  )
  expect(tried).toEqual(['fix sonnet', 'review sonnet', 'review opus'])
  expect(found[2]).toBe('review: fix.txt | Fix the build\n\nRan the failing test.')
  expect(report.results.map((u) => [u.step, u.status, u.retried])).toEqual([
    ['1-fix', 'done', undefined],
    ['2-review', 'failed', true],
    ['3-review', 'done', undefined],
  ])
  expect(report.results[0]?.outcome).toMatchObject({ kind: 'pr', commits: 1 })
  expect(failed).toBeUndefined()
})

it('numbers a retry inside a loop after every step folder', async () => {
  let reviews = 0
  const { report, units } = await retried(
    (skill) => (skill === 'review' && ++reviews === 2 ? 'fail' : 'ok'),
    '{ skill: fix, where: { checks: failing }, model: { claude: [sonnet, opus] }, then: { loop: [review], until: { verdict: nope }, max: 2 } }',
  )
  expect(report.results.map((u) => [u.step, u.status, u.retried])).toEqual([
    ['1-fix', 'done', undefined],
    ['2-review', 'done', undefined],
    ['3-review', 'failed', true],
    ['4-review', 'done', undefined],
  ])
  expect(report.results[0]?.loop).toBe('2 rounds of review; max 2 rounds reached')
  expect((await readdir(units)).sort()).toEqual([
    '1-fix',
    '2-review',
    '3-review',
    '4-review',
    'out',
  ])
})

it.each([
  ['fails too', 'fail', 'failed'],
  ['stops on quota', 'quota', 'stopped: quota'],
] as const)(
  'retries only once and counts one failure when the retry %s',
  async (_, retry, status) => {
    const { tried, report, failed } = await retried((_skill, model) =>
      model === 'sonnet' ? 'fail' : retry,
    )
    expect(tried).toEqual(['fix sonnet', 'fix opus'])
    expect(report.results.map((u) => [u.status, u.retried])).toEqual([
      ['failed', true],
      [status, undefined],
    ])
    expect(failed).toBe(1)
  },
)

it('keeps the failed attempt as without a list, and claims no retry, when the retry finds no provider left', async () => {
  const fallback: Allowance = { kind: 'fallback', units: 1, turns: 60, reason: 'no quota reading' }
  const { tried, report, failed, units } = await retried(
    () => 'fail',
    '{ skill: fix, where: { checks: failing }, model: { claude: [sonnet, opus] }, then: review }',
    fallback,
  )
  const plain = await retried(
    () => 'fail',
    '{ skill: fix, where: { checks: failing }, model: { claude: sonnet }, then: review }',
    fallback,
  )
  expect(tried).toEqual(['fix sonnet'])
  const why = 'no provider left: claude used its 1 fallback unit'
  expect(report.results.map((u) => [u.status, u.retried, u.reason])).toEqual([
    ['failed', undefined, `not retried: ${why}`],
    ['skipped', undefined, `acme-api-1 failed, not retried: ${why}`],
  ])
  expect(formatReport(report)).toContain(`| failed, 3 turns (not retried: ${why}) |`)
  expect(formatReport(report)).not.toContain('retried on the next model')
  expect(failed).toBe(1)
  expect(report.results[0]?.outcome).toEqual({
    ...plain.report.results[0]?.outcome,
    head: expect.any(String),
  })
  expect(await readFile(join(units, 'out', 'pr.md'), 'utf8')).toBe('Half a fix')
  expect(await readFile(join(plain.units, 'out', 'pr.md'), 'utf8')).toBe('Half a fix')
})

it("ends the chain and keeps the failed attempt's report when its clone can't be handed off", async () => {
  const { tried, report } = await retried(
    (_, model) => (model === 'sonnet' ? 'swap' : 'ok'),
    '{ skill: fix, where: { checks: failing }, model: { claude: [sonnet, opus] }, then: review }',
  )
  expect(tried).toEqual(['fix sonnet'])
  expect(report.results.map((u) => [u.status, u.retried, u.reported, u.reason])).toEqual([
    ['error', undefined, true, '.away/out in the clone is a symlink'],
    ['skipped', undefined, undefined, 'acme-api-1 error: .away/out in the clone is a symlink'],
  ])
})

it('retries from the clone exactly as the step found it, keeping what setup and earlier steps left', async () => {
  const { tried, found, tracked } = await retried(
    (skill, model) => (skill === 'fix' ? 'leave' : model === 'sonnet' ? 'fail' : 'ok'),
    '{ skill: fix, where: { checks: failing }, model: { claude: [sonnet, opus] }, then: review }',
    undefined,
    "repos: { acme/api: { setup: 'echo gen > gen.txt; echo setup > tracked.txt' } }",
  )
  expect(tried).toEqual(['fix sonnet', 'review sonnet', 'review opus'])
  expect(found[0]).toBe('fix: gen.txt | ')
  const before =
    'review: fix.txt gen.txt leftover.txt .away/out/notes.md | Fix the build\n\nRan the failing test.'
  expect(found.slice(1)).toEqual([before, before])
  expect(tracked).toEqual(['setup\n', 'setup\n', 'setup\n'])
})

it('retries with what setup staged still staged', async () => {
  const { tried, report } = await retried(
    (skill, model) => (skill === 'fix' && model === 'sonnet' ? 'fail' : 'ok'),
    '{ skill: fix, where: { checks: failing }, model: { claude: [sonnet, opus] }, then: { loop: [review], until: { command: "true" }, max: 1 } }',
    undefined,
    "repos: { acme/api: { setup: 'echo setup > tracked.txt; /usr/bin/git add tracked.txt' } }",
  )
  expect(tried).toEqual(['fix sonnet', 'fix opus', 'review sonnet'])
  expect(report.results[1]?.loop).toBe('1 round of review; until held: `true` passes')
})

it("runs no filter a submodule's own config names while it snapshots the clone for a retry", async () => {
  const root = await mkdtemp(join(tmpdir(), 'awaywork-sub-'))
  const lib = join(root, 'lib')
  await execa(bin('git'), ['init', '-q', lib])
  await writeFile(join(lib, 'a.txt'), 'a')
  await writeFile(join(lib, '.gitattributes'), '* filter=evil')
  await git(lib, 'add', '-A')
  await git(lib, 'commit', '-qm', 'lib')
  const ran = join(root, 'filter-ran')
  const g = bin('git')
  const setup = `PATH=/usr/bin:/bin; ${g} -c protocol.file.allow=always submodule add -q ${lib} sub && ${g} -C sub config filter.evil.clean "touch ${ran}; cat" && sleep 1 && touch sub/a.txt`
  const { tried } = await retried(
    (_, model) => (model === 'sonnet' ? 'fail' : 'ok'),
    retryRule,
    undefined,
    `repos: { acme/api: { setup: '${setup}' } }`,
  )
  expect(tried).toEqual(['fix sonnet', 'fix opus'])
  expect(existsSync(ran)).toBe(false)
})

it("retries a step without checking its rule's when again", async () => {
  // The failed attempt leaves 4.5% under the ceiling: the when wouldn't hold again.
  const { tried, report } = await retried(
    (_, model) => (model === 'sonnet' ? 'burn' : 'ok'),
    '{ skill: fix, where: { checks: failing }, model: { claude: [sonnet, opus] }, quota: { headroom: 10% } }',
  )
  expect(tried).toEqual(['fix sonnet', 'fix opus'])
  expect(report.results.map((u) => u.status)).toEqual(['failed', 'done'])
})

it('retries a step without checking its when again, keeping its when.log', async () => {
  const { tried, found } = await retried(
    (skill, model) => (skill === 'review' && model === 'sonnet' ? 'fail' : 'ok'),
    `{ skill: fix, where: { checks: failing }, model: { claude: [sonnet, opus] }, then: { skill: review, when: { command: "! sh -c 'echo boom; exit 1'" } } }`,
  )
  expect(tried).toEqual(['fix sonnet', 'review sonnet', 'review opus'])
  expect(found.slice(1).map((f) => f.includes('.away/context/previous/when.log'))).toEqual([
    true,
    true,
  ])
})

it("retries a step stopped on its model's own window on the second model, where the next step starts too", async () => {
  const { tried, report } = await retried(
    (_, model) => (model === 'sonnet' ? 'full' : 'ok'),
    '{ skill: fix, where: { checks: failing }, model: { claude: [sonnet, opus] }, then: review }',
    roomy,
  )
  expect(tried).toEqual(['fix sonnet', 'fix opus', 'review opus'])
  expect(report.results.map((u) => [u.status, u.retried, u.reason])).toEqual([
    ['stopped: quota', true, 'seven_day_sonnet at 95%, ceiling 80%'],
    ['done', undefined, undefined],
    ['done', undefined, undefined],
  ])
  expect(formatReport(report)).toContain(
    '- claude: seven_day 36% to 45%, ceiling 80%; seven_day_sonnet (sonnet) 95%, ceiling 80%',
  )
})

it('starts on the second model when the first is already past its own ceiling', async () => {
  const { tried, report } = await retried(() => 'ok', retryRule, {
    ...roomy,
    models: { sonnet: [sonnetWeek] },
  })
  expect(tried).toEqual(['fix opus'])
  expect(report.results.map((u) => [u.status, u.retried])).toEqual([['done', undefined]])
})

it('passes the provider over when its only model is past its own ceiling', async () => {
  const { tried, report } = await retried(
    () => 'ok',
    '{ skill: fix, where: { checks: failing }, model: { claude: sonnet } }',
    { ...roomy, models: { sonnet: [sonnetWeek] } },
  )
  expect(tried).toEqual([])
  expect(report.results.map((u) => [u.status, u.reason])).toEqual([
    [
      'skipped',
      'no provider left: claude on sonnet at its ceiling (seven_day_sonnet at 95%, ceiling 80%)',
    ],
  ])
})

it("ends a single model's stop on its own window as stopped, with no retry", async () => {
  const { tried, logs, report } = await retried(
    () => 'full',
    '{ skill: fix, where: { checks: failing }, model: { claude: sonnet }, then: review }',
    roomy,
  )
  expect(tried).toEqual(['fix sonnet'])
  expect(report.results.map((u) => [u.status, u.retried, u.reason])).toEqual([
    ['stopped: quota', undefined, 'seven_day_sonnet at 95%, ceiling 80%'],
    ['skipped', undefined, 'acme-api-1 stopped: quota'],
  ])
  expect(logs.join('\n')).not.toContain('retrying')
})

it("names the stop, not a failure, when the second model's own window is full too", async () => {
  const opusWeek = { ...sonnetWeek, name: 'seven_day_opus' }
  const { tried, logs, report } = await retried(
    () => 'full',
    '{ skill: fix, where: { checks: failing }, model: { claude: [sonnet, opus] }, then: review }',
    { ...roomy, models: { opus: [opusWeek] } },
  )
  expect(tried).toEqual(['fix sonnet'])
  const why = 'no provider left: claude on opus at its ceiling (seven_day_opus at 95%, ceiling 80%)'
  expect(report.results.map((u) => [u.status, u.reason])).toEqual([
    ['stopped: quota', 'seven_day_sonnet at 95%, ceiling 80%'],
    ['skipped', `acme-api-1 stopped: quota, not retried: ${why}`],
  ])
  expect(logs.join('\n')).not.toContain('retrying')
})
