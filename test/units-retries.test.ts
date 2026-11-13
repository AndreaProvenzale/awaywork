import { existsSync } from 'node:fs'
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execa } from 'execa'
import { expect, it } from 'vitest'
import { parseConfig } from '#config/load'
import { bin, builtinSkillsDir } from '#config/paths'
import { builtinSkills } from '#core/skills'
import type { Provider, Source } from '#core/types'
import { recordAttempts } from '#plan/attempts'
import { planRun } from '#plan/foreman'
import { formatReport } from '#posts/report'
import { type Allowance, allowance } from '#quota/budget'
import { unitStats } from '#run/stats'
import { runUnits } from '#worker/units'
import { withRepos } from './fakes/acme'
import { fakeForge } from './fakes/forge'
import { githubPr } from './fakes/items'
import { fakeSource } from './fakes/source'
import { git, quota, reset, worker } from './fakes/units'

const retryRule = '{ skill: fix, where: { checks: failing }, model: { claude: [sonnet, opus] } }'

/**
 * Runs one PR's rule with a provider that does `act(skill, model)`: a failing run first leaves partial
 * work behind (`burn` also uses quota), and `leave` succeeds but leaves an uncommitted file and an extra `out/` file.
 */
async function retried(
  act: (skill: string, model?: string) => 'ok' | 'fail' | 'burn' | 'quota' | 'leave',
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
      if (does === 'leave') {
        await writeFile(join(job.dir, 'leftover.txt'), 'uncommitted')
        await writeFile(join(job.dir, '.away/out/notes.md'), 'notes')
      }
      if (does === 'quota') {
        yield { type: 'quota', quota: quota(0.99) }
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
    config,
    items: [githubPr(1, { checks: 'failing', updated: '2026-09-01T00:00:00Z' })],
    allowances,
    skills: { builtin: builtinSkills },
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
    ctx: { env: { PATH: '/bin' }, log: () => {} },
    watch: () => ({ stop: async () => {} }),
    shortage: async () => undefined,
    skillDirs: { user: join(root, 'none'), builtin: builtinSkillsDir },
  })
  const failed = recordAttempts({}, report)['github:acme/api#1']?.failed
  return { tried, found, tracked, report, failed, units: join(runDir, 'units', 'acme-api-1') }
}

it('retries a failed step once on the next model', async () => {
  const { tried, report, failed } = await retried((_, model) =>
    model === 'sonnet' ? 'fail' : 'ok',
  )
  expect(tried).toEqual(['fix sonnet', 'fix opus'])
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
