import { mkdir, mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { parseConfig } from '../src/config/load.js'
import { builtinSkillsDir } from '../src/config/paths.js'
import { builtinSkills } from '../src/core/skills.js'
import type { Source } from '../src/core/types.js'
import { formatPlan } from '../src/format/plan.js'
import { summarize } from '../src/format/report.js'
import { recordAttempts } from '../src/plan/attempts.js'
import { planRun } from '../src/plan/foreman.js'
import { formatReport, runLine } from '../src/posts/report.js'
import { allowance } from '../src/quota/budget.js'
import { runUnits } from '../src/worker/units.js'
import { githubPr, issue } from './fakes/items.js'
import { fakeSource } from './fakes/source.js'
import { committer, git, looper, originForge, quota, reset, week } from './fakes/units.js'

it("loops review and fix in the chain's clone until the verdict holds, and reports the chain with its steps under it", async () => {
  const root = await mkdtemp(join(tmpdir(), 'awaywork-loop-'))
  const { opened, forge } = await originForge(root)
  const config = parseConfig(`
providers: [claude: {}]
repos: { acme/*: {} }
sources: { github: {} }
queue:
  - skill: implement
    then:
      - { loop: [review, fix], until: { verdict: approve }, max: 3 }
      - plan
`)
  const now = reset * 1000 - 3 * 24 * 60 * 60 * 1000
  const plan = planRun({
    config,
    items: [issue(1)],
    allowances: { claude: allowance(config.budget, quota(0.36), now, config.windows) },
    skills: { builtin: builtinSkills },
  })
  const verdicts = { 'acme-api-1-review-1': 'changes', 'acme-api-1-review-2': 'approve' }
  const prompts: string[] = []
  const provider = looper(verdicts)
  const runDir = join(root, 'run')
  const report = await runUnits({
    config,
    configDir: root,
    plan,
    runId: 'r1',
    runDir,
    dryRun: false,
    providers: {
      claude: {
        ...provider,
        run: (job, signal) => {
          prompts.push(job.prompt)
          return provider.run(job, signal)
        },
      },
    },
    sources: { github: fakeSource() as Source },
    forge,
    ctx: { env: {}, log: () => {} },
    watch: () => ({ stop: async () => {} }),
    shortage: async () => undefined,
    skillDirs: { user: join(root, 'none'), builtin: builtinSkillsDir },
  })

  const url = 'https://example.com/acme/api/pull/away/acme-api-1'
  expect(opened.map((pr) => [pr.head, pr.base])).toEqual([['away/acme-api-1', '']])
  expect(report.results.map((u) => u.step)).toEqual([
    '1-implement',
    '2-review',
    '3-fix',
    '4-review',
    '5-plan',
  ])
  expect((await readdir(join(runDir, 'units/acme-api-1'))).sort()).toEqual([
    '1-implement',
    '2-review',
    '3-fix',
    '4-review',
    '5-plan',
    'out',
  ])
  expect(await readFile(join(runDir, 'units/acme-api-1/4-review/out/report.md'), 'utf8')).toBe(
    'acme-api-1-review-2 says approve.',
  )
  expect(await readFile(join(runDir, 'units/acme-api-1/out/pr.md'), 'utf8')).toContain(
    '## Awaywork chain',
  )
  expect(prompts[2]).toContain(
    'It is round 1 of at most 3 of a loop (`review` ⇄ `fix`) that ends once verdict approve.',
  )
  expect(prompts[4]).toContain(
    'This unit is a step of a chain (implement → loop(review ⇄ fix) → plan) whose steps all work in this clone',
  )
  const text = formatReport(report)
  expect(text).toContain(
    [
      `| 1 | [api#1 Fix the thing](https://example.com/1) | implement → loop(review ⇄ fix) → plan | claude | done, 5 turns (loop: 2 rounds of review ⇄ fix; until held: verdict approve) | ${url} (2 commits), verdict approve |`,
      '|  | └ acme-api-1 | implement | claude | done, 1 turn | 1 commit |',
      '|  | └ acme-api-1-review-1 | review | claude | done, 1 turn | a report, verdict changes |',
      '|  | └ acme-api-1-fix-1 | fix | claude | done, 1 turn | 1 commit |',
      '|  | └ acme-api-1-review-2 | review | claude | done, 1 turn | a report, verdict approve |',
      '|  | └ acme-api-1-plan | plan | claude | done, 1 turn | a report |',
    ].join('\n'),
  )
  expect(runLine('r1', text)).toBe('r1  1 unit, 1 draft PR, 0 reports')
  expect(summarize(report, 'report.md').split('\n').slice(2)).toEqual([
    `  1  api#1  implement → loop(review ⇄ fix) → plan  done, 5 turns  ${url}, verdict approve`,
    '     Done.',
    'Report: report.md',
  ])
})

it('ends a loop when no provider is left for a round, and publishes what it has', async () => {
  const root = await mkdtemp(join(tmpdir(), 'awaywork-loop-budget-'))
  const { opened, forge } = await originForge(root)
  const config = parseConfig(`
providers: [claude: {}]
repos: { acme/*: {} }
sources: { github: {} }
budget: { fallback: { units: 3, turns: 10 } }
queue:
  - skill: implement
    then: { loop: [review, fix], until: { verdict: approve }, max: 3 }
`)
  const plan = planRun({
    config,
    items: [issue(1)],
    allowances: { claude: allowance(config.budget, null, 0, config.windows) },
    skills: { builtin: builtinSkills },
  })
  const report = await runUnits({
    config,
    configDir: root,
    plan,
    runId: 'r1',
    runDir: join(root, 'run'),
    dryRun: false,
    providers: { claude: looper({ 'acme-api-1-review-1': 'changes' }) },
    sources: { github: fakeSource() as Source },
    forge,
    ctx: { env: {}, log: () => {} },
    watch: () => ({ stop: async () => {} }),
    shortage: async () => undefined,
    skillDirs: { user: join(root, 'none'), builtin: builtinSkillsDir },
  })

  const noProvider = 'no provider left: claude used its 3 fallback units'
  expect(report.results.map((u) => [u.planned.unit.id, u.status, u.loop ?? u.reason])).toEqual([
    ['acme-api-1', 'done', `1 round of review ⇄ fix; ${noProvider}`],
    ['acme-api-1-review-1', 'done', undefined],
    ['acme-api-1-fix-1', 'done', undefined],
    ['acme-api-1-review-2', 'skipped', noProvider],
  ])
  expect(opened.map((pr) => pr.head)).toEqual(['away/acme-api-1'])
})

it('loops after a report step up to max, and reports a chain whose loop only reported', async () => {
  const root = await mkdtemp(join(tmpdir(), 'awaywork-loop-report-'))
  const { origin, opened, forge } = await originForge(root)
  await git(origin, 'branch', 'feature-4')
  const config = parseConfig(`
providers: [claude: {}]
repos: { acme/*: {} }
sources: { github: {} }
queue:
  - skill: plan
    where: { type: issue }
    then: { loop: [implement, review], until: { verdict: approve }, max: 2 }
  - skill: review
    where: { type: pr }
    deliver: report
    then: { loop: fix, until: { verdict: approve }, max: 1 }
`)
  const now = reset * 1000 - 3 * 24 * 60 * 60 * 1000
  const plan = planRun({
    config,
    items: [issue(1), githubPr(4)],
    allowances: { claude: allowance(config.budget, quota(0.36), now, config.windows) },
    skills: { builtin: builtinSkills },
  })
  const verdicts = {
    'acme-api-1-review-1': 'changes',
    'acme-api-1-review-2': 'changes',
    'acme-api-4-fix-1': 'approve',
  }
  const report = await runUnits({
    config,
    configDir: root,
    plan,
    runId: 'r1',
    runDir: join(root, 'run'),
    dryRun: false,
    providers: { claude: looper(verdicts) },
    sources: { github: fakeSource() as Source },
    forge,
    ctx: { env: {}, log: () => {} },
    watch: () => ({ stop: async () => {} }),
    shortage: async () => undefined,
    skillDirs: { user: join(root, 'none'), builtin: builtinSkillsDir },
  })

  expect(report.results.map((u) => [u.planned.unit.id, u.outcome?.kind, u.loop])).toEqual([
    ['acme-api-1', 'pr', '2 rounds of implement ⇄ review; max 2 rounds reached'],
    ['acme-api-1-implement-1', undefined, undefined],
    ['acme-api-1-review-1', undefined, undefined],
    ['acme-api-1-implement-2', undefined, undefined],
    ['acme-api-1-review-2', undefined, undefined],
    ['acme-api-4', 'report', '1 round of fix; until held: verdict approve'],
    ['acme-api-4-fix-1', undefined, undefined],
  ])
  expect(report.results[5]?.outcome).toEqual({
    kind: 'report',
    text: '### acme-api-4\n\nacme-api-4 says nothing.\n\n### acme-api-4-fix-1\n\nacme-api-4-fix-1 says approve.',
  })
  expect(opened.map((pr) => [pr.head, pr.base])).toEqual([['away/acme-api-1', '']])
  const files = await git(origin, 'ls-tree', '--name-only', 'away/acme-api-1')
  expect(files.stdout.split('\n')).toEqual([
    'acme-api-1-implement-1.txt',
    'acme-api-1-implement-2.txt',
  ])
})

it('ends a loop once its command passes, runs it once per commit without the askpass helper, and hands its output to the next step', async () => {
  const root = await mkdtemp(join(tmpdir(), 'awaywork-loop-command-'))
  const { opened, forge } = await originForge(root)
  const command = 'echo "run$GIT_ASKPASS" >> "$COUNT"; test -e acme-api-1-fix-2.txt'
  const config = parseConfig(`
providers: [claude: {}]
repos: { acme/*: {} }
sources: { github: {} }
queue:
  - skill: implement
    then: { loop: [review, fix], until: { command: '${command}' }, max: 3 }
`)
  const plan = planRun({
    config,
    items: [issue(1)],
    allowances: { claude: allowance(config.budget, quota(0.36), week, config.windows) },
    skills: { builtin: builtinSkills },
  })
  const seen: Record<string, string[]> = {}
  const prompts: string[] = []
  const provider = looper({}, seen)
  const count = join(root, 'count')
  const report = await runUnits({
    config,
    configDir: root,
    plan,
    runId: 'r1',
    runDir: join(root, 'run'),
    dryRun: false,
    providers: {
      claude: {
        ...provider,
        run: (job, signal) => {
          prompts.push(job.prompt)
          return provider.run(job, signal)
        },
      },
    },
    sources: { github: fakeSource() as Source },
    forge,
    ctx: { env: { PATH: process.env.PATH, COUNT: count, GIT_ASKPASS: '/askpass' }, log: () => {} },
    watch: () => ({ stop: async () => {} }),
    shortage: async () => undefined,
    skillDirs: { user: join(root, 'none'), builtin: builtinSkillsDir },
  })

  expect(report.results[0]?.loop).toBe(
    `2 rounds of review ⇄ fix; until held: \`${command}\` passes`,
  )
  expect(report.results.map((u) => u.planned.unit.id)).toEqual([
    'acme-api-1',
    'acme-api-1-review-1',
    'acme-api-1-fix-1',
    'acme-api-1-review-2',
    'acme-api-1-fix-2',
  ])
  // Reviews commit nothing: the check runs once per commit.
  expect(await readFile(count, 'utf8')).toBe('run\nrun\nrun\n')
  expect(seen['acme-api-1-fix-1']).toEqual(['check.log', 'pr.md', 'report.md'])
  expect(seen['acme-api-1-review-2']).toEqual(['check.log', 'diff.patch', 'pr.md'])
  const log = await readFile(join(root, 'run/units/acme-api-1/2-review/out/check.log'), 'utf8')
  expect(log).toMatch(/^\$ echo "run\$GIT_ASKPASS" >> "\$COUNT"; test -e acme-api-1-fix-2\.txt\n/)
  expect(log).toMatch(/\nfailed: Command failed with exit code 1: .*\n$/)
  expect(prompts[2]).toContain(', which awaywork ran after it, in `check.log`.')
  expect(opened.map((pr) => pr.head)).toEqual(['away/acme-api-1'])
  expect(opened[0]?.body).not.toContain('Last check')
})

it("publishes a loop that reached max with the failing check's output in the PR body", async () => {
  const root = await mkdtemp(join(tmpdir(), 'awaywork-loop-check-failed-'))
  const { opened, forge } = await originForge(root)
  const config = parseConfig(`
providers: [claude: {}]
repos: { acme/*: {} }
sources: { github: {} }
queue:
  - skill: implement
    then: { loop: fix, until: { command: 'echo 3 tests failed; false' }, max: 1 }
`)
  const plan = planRun({
    config,
    items: [issue(1)],
    allowances: { claude: allowance(config.budget, null, 0, config.windows) },
    skills: { builtin: builtinSkills },
  })
  const report = await runUnits({
    config,
    configDir: root,
    plan,
    runId: 'r1',
    runDir: join(root, 'run'),
    dryRun: false,
    providers: { claude: looper({}) },
    sources: { github: fakeSource() as Source },
    forge,
    ctx: { env: { PATH: process.env.PATH }, log: () => {} },
    watch: () => ({ stop: async () => {} }),
    shortage: async () => undefined,
    skillDirs: { user: join(root, 'none'), builtin: builtinSkillsDir },
  })

  expect(report.results[0]?.loop).toBe('1 round of fix; max 1 round reached')
  const body = opened[0]?.body ?? ''
  expect(body).toContain(
    [
      '<details><summary>Last check: `echo 3 tests failed; false` failed</summary>',
      '',
      '```',
      '$ echo 3 tests failed; false',
      '3 tests failed',
    ].join('\n'),
  )
  expect(body).toMatch(
    /\nfailed: Command failed with exit code 1: .*\n```\n\n<\/details>\n\n\nCloses acme\/api#1\n$/,
  )
})

it("skips a rule whose quota doesn't hold, and runs one whose does", async () => {
  const root = await mkdtemp(join(tmpdir(), 'awaywork-when-quota-'))
  const { forge } = await originForge(root)
  const config = parseConfig(`
providers: [claude: {}]
repos: { acme/*: {} }
sources: { github: {} }
queue:
  - { skill: review, where: { title: { matches: one } }, deliver: report, quota: { runs_until_reset: 1 } }
  - { skill: implement, where: { title: { matches: two } }, quota: { headroom: 10% } }
`)
  const plan = planRun({
    config,
    items: [
      { ...issue(1), title: 'one' },
      { ...issue(2), title: 'two' },
    ],
    allowances: { claude: allowance(config.budget, quota(0.36), week, config.windows) },
    skills: { builtin: builtinSkills },
  })
  const logged: string[] = []
  const report = await runUnits({
    config,
    configDir: root,
    plan,
    runId: 'r1',
    runDir: join(root, 'run'),
    dryRun: false,
    providers: { claude: committer },
    sources: { github: fakeSource() as Source },
    forge,
    ctx: { env: { PATH: process.env.PATH }, log: (line) => logged.push(line) },
    watch: () => ({ stop: async () => {} }),
    shortage: async () => undefined,
    skillDirs: { user: join(root, 'none'), builtin: builtinSkillsDir },
  })
  const [review, implemented] = report.results
  expect(review?.status).toBe('skipped')
  expect(review?.reason).toMatch(/^quota: the window resets within 1 run didn't hold/)
  expect(implemented?.status).toBe('done')
  expect(logged).toEqual([
    "acme-api-1: skipped, quota: the window resets within 1 run didn't hold",
    'acme-api-2: implement on claude',
    'acme-api-2: done',
  ])
})

it('records no attempt for a rule whose quota does not hold', async () => {
  const root = await mkdtemp(join(tmpdir(), 'awaywork-when-quota-'))
  const { forge } = await originForge(root)
  const config = parseConfig(`
providers: [claude: {}]
repos: { acme/*: {} }
sources: { github: {} }
queue:
  - skill: implement
    where: { type: issue }
    quota: { runs_until_reset: 1 }
`)
  const item = { ...issue(1), fields: { repo: 'acme/api', updated: '2026-01-01T00:00:00Z' } }
  const plan = planRun({
    config,
    items: [item],
    allowances: { claude: allowance(config.budget, quota(0.36), week, config.windows) },
    skills: { builtin: builtinSkills },
  })
  const report = await runUnits({
    config,
    configDir: root,
    plan,
    runId: 'r1',
    runDir: join(root, 'run'),
    dryRun: false,
    providers: { claude: committer },
    sources: { github: fakeSource() as Source },
    forge,
    ctx: { env: { PATH: process.env.PATH }, log: () => {} },
    watch: () => ({ stop: async () => {} }),
    shortage: async () => undefined,
    skillDirs: { user: join(root, 'none'), builtin: builtinSkillsDir },
  })
  expect(report.results[0]?.passedOver).toBe(true)
  expect(recordAttempts({}, report)).toEqual({})
})

it("passes over a step whose when doesn't hold, and reads the latest verdict in the chain", async () => {
  const root = await mkdtemp(join(tmpdir(), 'awaywork-when-'))
  const { origin, opened, forge } = await originForge(root)
  await git(origin, 'branch', 'feature-4')
  await mkdir(join(root, 'skills/triage'), { recursive: true })
  await writeFile(join(root, 'skills/triage/SKILL.md'), '---\nname: triage\n---\n')
  const config = parseConfig(`
providers: [claude: {}]
repos: { acme/*: {} }
sources: { github: {} }
queue:
  - skill: implement
    where: { type: issue }
    then:
      - { skill: review, when: { changed: "*.txt" } }
      - { skill: plan, when: { command: "test -e acme-api-1.txt" } }
      - { skill: fix, when: { verdict: changes } }
      - { skill: triage, when: { verdict: { not: changes }, changed: "docs/**" } }
  - skill: review
    where: { type: pr }
    deliver: report
    then: { skill: fix, when: { command: "true" } }
`)
  const item = { ...issue(1), fields: { repo: 'acme/api', updated: '2026-01-01T00:00:00Z' } }
  const plan = planRun({
    config,
    items: [item, githubPr(4, { mine: false, trusted: false, updated: '2026-01-01T00:00:00Z' })],
    allowances: { claude: allowance(config.budget, quota(0.36), week, config.windows) },
    skills: { user: { triage: {} }, builtin: builtinSkills },
  })
  const seen: Record<string, string[]> = {}
  const report = await runUnits({
    config,
    configDir: root,
    plan,
    runId: 'r1',
    runDir: join(root, 'run'),
    dryRun: false,
    providers: { claude: looper({ 'acme-api-1-review': 'changes' }, seen) },
    sources: { github: fakeSource() as Source },
    forge,
    ctx: { env: { PATH: process.env.PATH }, log: () => {} },
    watch: () => ({ stop: async () => {} }),
    shortage: async () => undefined,
    skillDirs: { user: join(root, 'skills'), builtin: builtinSkillsDir },
  })

  expect(report.results.map((u) => [u.planned.unit.id, u.status, u.reason])).toEqual([
    ['acme-api-1', 'done', undefined],
    ['acme-api-1-review', 'done', undefined],
    ['acme-api-1-plan', 'done', undefined],
    ['acme-api-1-fix', 'done', undefined],
    [
      'acme-api-1-triage',
      'skipped',
      "when verdict not changes and the branch changes docs/** didn't hold",
    ],
    ['acme-api-4', 'done', undefined],
    [
      'acme-api-4-fix',
      'skipped',
      "when `true` passes didn't hold (not run on an untrusted author's PR)",
    ],
  ])
  expect(opened.map((pr) => [pr.head, pr.base])).toEqual([['away/acme-api-1', '']])
  expect(seen['acme-api-1-plan']).toEqual(['pr.md', 'report.md', 'verdict', 'when.log'])
  const prompt = await readFile(join(root, 'run/units/acme-api-1/3-plan/prompt.md'), 'utf8')
  expect(prompt).toContain('Before you started, awaywork ran `test -e acme-api-1.txt`')
  const attempts = recordAttempts({}, report)
  expect(attempts['github:acme/api#1']).toEqual({
    runId: 'r1',
    skill: 'implement',
    updated: '2026-01-01T00:00:00Z',
    report: { runId: 'r1', unit: 'acme-api-1', step: '3-plan', skill: 'plan' },
  })
  expect(attempts['github:acme/api#4']).toEqual({
    runId: 'r1',
    skill: 'review',
    updated: '2026-01-01T00:00:00Z',
    report: { runId: 'r1', unit: 'acme-api-4', step: '1-review', skill: 'review' },
  })
  expect(formatPlan(plan)).toContain('     then fix (built-in) on claude, when verdict changes\n')
})

it("passes over a loop step whose when doesn't hold, and still ends the loop at max", async () => {
  const root = await mkdtemp(join(tmpdir(), 'awaywork-loop-when-'))
  const { opened, forge } = await originForge(root)
  const config = parseConfig(`
providers: [claude: {}]
repos: { acme/*: {} }
sources: { github: {} }
queue:
  - skill: implement
    then:
      loop: [review, { skill: fix, when: { verdict: changes } }]
      until: { verdict: approve }
      max: 2
`)
  const plan = planRun({
    config,
    items: [issue(1)],
    allowances: { claude: allowance(config.budget, quota(0.36), week, config.windows) },
    skills: { builtin: builtinSkills },
  })
  const verdicts = { 'acme-api-1-review-1': 'changes', 'acme-api-1-review-2': 'comments' }
  const report = await runUnits({
    config,
    configDir: root,
    plan,
    runId: 'r1',
    runDir: join(root, 'run'),
    dryRun: false,
    providers: { claude: looper(verdicts) },
    sources: { github: fakeSource() as Source },
    forge,
    ctx: { env: {}, log: () => {} },
    watch: () => ({ stop: async () => {} }),
    shortage: async () => undefined,
    skillDirs: { user: join(root, 'none'), builtin: builtinSkillsDir },
  })

  expect(report.results.map((u) => [u.planned.unit.id, u.status, u.loop ?? u.reason])).toEqual([
    ['acme-api-1', 'done', '2 rounds of review ⇄ fix; max 2 rounds reached'],
    ['acme-api-1-review-1', 'done', undefined],
    ['acme-api-1-fix-1', 'done', undefined],
    ['acme-api-1-review-2', 'done', undefined],
    ['acme-api-1-fix-2', 'skipped', "when verdict changes didn't hold"],
  ])
  expect(opened.map((pr) => pr.head)).toEqual(['away/acme-api-1'])
  expect(opened[0]?.body).toContain('acme-api-1-review-2 says comments.')
})
