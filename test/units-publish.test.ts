import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { parseConfig } from '../src/config/load.js'
import { builtinSkillsDir } from '../src/config/paths.js'
import { builtinSkills } from '../src/core/skills.js'
import type { Provider, PrRef, Source } from '../src/core/types.js'
import { formatPlan } from '../src/format/plan.js'
import { planRun } from '../src/plan/foreman.js'
import { footer } from '../src/posts/footer.js'
import { formatReport } from '../src/posts/report.js'
import { allowance } from '../src/quota/budget.js'
import { runUnits } from '../src/worker/units.js'
import { fakeForge } from './fakes/forge.js'
import { githubPr, issue } from './fakes/items.js'
import { fakeProvider } from './fakes/provider.js'
import { fakeSource } from './fakes/source.js'
import { committer, git, looper, loopRun, originForge, quota, week, worker } from './fakes/units.js'

it("starts each of a repo's draft PRs from the default branch, not on this run's last one", async () => {
  const root = await mkdtemp(join(tmpdir(), 'awaywork-stack-'))
  const { origin, opened, forge } = await originForge(root)
  await git(origin, 'branch', 'feature-4')
  const prompts: string[] = []
  const implementer: Provider = {
    ...fakeProvider('claude'),
    async *run(job) {
      prompts.push(job.prompt)
      if (job.unit.id !== 'acme-api-2') {
        await writeFile(join(job.dir, `${job.unit.id}.txt`), 'done')
        await git(job.dir, 'add', '.')
        await git(job.dir, 'commit', '-qm', `Implement ${job.unit.id}`)
        await writeFile(join(job.dir, '.away/out/pr.md'), `Implement ${job.unit.id}\n\nDone.`)
      }
      yield { type: 'done', ok: true, turns: 1 }
    },
  }
  const config = parseConfig(
    'providers: [claude: {}]\nrepos: { acme/*: {} }\nsources: { github: {} }\nqueue: [{ skill: implement }]',
  )
  const plan = planRun({
    config,
    items: [issue(1), issue(2), githubPr(4), issue(3)],
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
    providers: { claude: implementer },
    sources: { github: fakeSource() as Source },
    forge,
    ctx: { env: {}, log: () => {} },
    watch: () => ({ stop: async () => {} }),
    shortage: async () => undefined,
    skillDirs: { user: join(root, 'none'), builtin: builtinSkillsDir },
  })

  expect(report.results.map((u) => u.outcome)).toContainEqual({
    kind: 'pr',
    url: 'https://example.com/acme/api/pull/away/acme-api-3',
    commits: 1,
    head: expect.any(String),
  })
  expect(opened.map((pr) => [pr.head, pr.base])).toEqual([
    ['away/acme-api-1', ''],
    ['away/acme-api-4', 'feature-4'],
    ['away/acme-api-3', ''],
  ])
  expect(opened[2]?.body).toBe('Implement acme-api-3\n\nDone.\n\nCloses acme/api#3\n')
  expect([prompts[0], prompts[1], prompts[3]]).toEqual([
    expect.stringContaining('cut from the default branch.'),
    expect.stringContaining('cut from the default branch.'),
    expect.stringContaining('cut from the default branch.'),
  ])
  expect(forge.stacked).toEqual([])
  const files = await git(origin, 'ls-tree', '--name-only', 'away/acme-api-3')
  expect(files.stdout.split('\n')).toEqual(['acme-api-3.txt'])
})

it("publishes a chain as one draft PR, and starts the repo's next chain from the default branch", async () => {
  const root = await mkdtemp(join(tmpdir(), 'awaywork-chain-pr-'))
  const { opened, forge } = await originForge(root)
  const config = parseConfig(`
providers: [claude: {}]
repos: { acme/*: {} }
sources: { github: {} }
queue: [{ skill: implement, then: review }]
`)
  const plan = planRun({
    config,
    items: [issue(1), issue(2)],
    allowances: { claude: allowance(config.budget, null, 0, config.windows) },
    skills: { builtin: builtinSkills },
  })
  await runUnits({
    config,
    configDir: root,
    plan,
    runId: 'r1',
    runDir: join(root, 'run'),
    dryRun: false,
    providers: { claude: committer },
    sources: { github: fakeSource() as Source },
    forge,
    ctx: { env: {}, log: () => {} },
    watch: () => ({ stop: async () => {} }),
    shortage: async () => undefined,
    skillDirs: { user: join(root, 'none'), builtin: builtinSkillsDir },
  })

  expect(opened.map((pr) => [pr.head, pr.base])).toEqual([
    ['away/acme-api-1', ''],
    ['away/acme-api-2', ''],
  ])
  expect(opened[1]?.body).toBe(
    [
      'Work on acme-api-2',
      '',
      'Done.',
      '',
      '## Awaywork chain',
      '',
      '<details><summary>Report: acme-api-2-review</summary>',
      '',
      'Approve.',
      '',
      '</details>',
      '',
      '',
      'Closes acme/api#2',
      '',
    ].join('\n'),
  )
  expect(forge.stacked).toEqual([])
})

it("starts a chain on your own PR from its branch, and the repo's other units from the default branch", async () => {
  const root = await mkdtemp(join(tmpdir(), 'awaywork-chain-own-'))
  const { origin, opened, forge } = await originForge(root)
  await git(origin, 'branch', 'feature-4')
  const config = parseConfig(`
providers: [claude: {}]
repos: { acme/*: {} }
sources: { github: {} }
queue:
  - { skill: implement, where: { type: pr }, then: review }
  - { skill: implement }
`)
  const plan = planRun({
    config,
    items: [issue(1), githubPr(4), issue(3)],
    allowances: { claude: allowance(config.budget, null, 0, config.windows) },
    skills: { builtin: builtinSkills },
  })
  await runUnits({
    config,
    configDir: root,
    plan,
    runId: 'r1',
    runDir: join(root, 'run'),
    dryRun: false,
    providers: { claude: committer },
    sources: { github: fakeSource() as Source },
    forge,
    ctx: { env: {}, log: () => {} },
    watch: () => ({ stop: async () => {} }),
    shortage: async () => undefined,
    skillDirs: { user: join(root, 'none'), builtin: builtinSkillsDir },
  })

  expect(opened.map((pr) => [pr.head, pr.base])).toEqual([
    ['away/acme-api-4', 'feature-4'],
    ['away/acme-api-1', ''],
    ['away/acme-api-3', ''],
  ])
  expect(opened[0]?.body).not.toContain('Stacked on')
  const files = await git(origin, 'ls-tree', '--name-only', 'away/acme-api-3')
  expect(files.stdout.split('\n')).toEqual(['acme-api-3.txt'])
})

it('pushes a chain onto your own PR once, with its summary in pr.md and setup run once', async () => {
  const root = await mkdtemp(join(tmpdir(), 'awaywork-push-'))
  const { origin, opened, forge } = await originForge(root)
  await git(origin, 'branch', 'feature-1')
  const config = parseConfig(`
providers: [claude: {}]
sources: { github: {} }
queue: [{ skill: fix, deliver: push, then: implement }]
repos:
  acme/api:
    setup: 'echo "$NPM_TOKEN" >> .away/setup.txt'
    secrets: [NPM_TOKEN]
`)
  const plan = planRun({
    config,
    items: [githubPr(1)],
    allowances: { claude: allowance(config.budget, null, 0, config.windows) },
    skills: { builtin: builtinSkills },
  })
  const prompts: string[] = []
  const report = await runUnits({
    config,
    configDir: root,
    plan,
    runId: 'r1',
    runDir: join(root, 'run'),
    dryRun: false,
    providers: {
      claude: {
        ...committer,
        run: (job, signal) => {
          prompts.push(job.prompt)
          return committer.run(job, signal)
        },
      },
    },
    sources: { github: fakeSource() as Source },
    forge,
    ctx: { env: { PATH: process.env.PATH, NPM_TOKEN: 'npm' }, log: () => {} },
    watch: () => ({ stop: async () => {} }),
    shortage: async () => undefined,
    skillDirs: { user: join(root, 'none'), builtin: builtinSkillsDir },
  })

  expect(report.results.map((u) => u.outcome ?? u.made)).toEqual([
    {
      kind: 'pushed',
      branch: 'feature-1',
      url: 'https://github.com/acme/api/pull/1',
      commits: 2,
      text: 'Work on acme-api-1-implement\n\nDone.',
      head: (await git(origin, 'rev-parse', 'feature-1')).stdout,
    },
    '1 commit',
  ])
  const pushed = await git(
    origin,
    'log',
    '--format=%s|%(trailers:key=Awaywork,valueonly)',
    'feature-1',
  )
  expect(pushed.stdout.split('\n').filter(Boolean)).toEqual([
    'Work on acme-api-1-implement|r1',
    'Work on acme-api-1|r1',
    'init|',
  ])
  expect(opened).toEqual([])
  const setup = await readFile(join(root, 'run/units/acme-api-1/2-implement/setup.txt'), 'utf8')
  expect(setup).toBe('npm\n')
  expect(prompts[0]).toContain(
    "Deliver: commits pushed onto `feature-1`, the developer's own pull request. Commit on this branch and write `.away/out/pr.md`, a summary for the developer.",
  )
  expect(prompts[1]).toContain(
    'Commit on this branch and keep `.away/out/pr.md` current: it holds what the chain did so far, a summary for the developer.',
  )
  const text = formatReport(report)
  expect(text).toContain(
    '| 1 | [api#1 PR 1](https://github.com/acme/api/pull/1) | fix → implement | claude | done, 2 turns | 2 commits pushed onto feature-1, report below |',
  )
  expect(text).toContain(
    '|  | └ acme-api-1-implement | implement | claude | done, 1 turn | 1 commit |',
  )
  expect(text).toContain('### api#1: PR 1 (fix)\n\nhttps://github.com/acme/api/pull/1\n\n')
})

it("pushes every round's commits onto your PR once, with how the loop went in the summary", async () => {
  const root = await mkdtemp(join(tmpdir(), 'awaywork-push-loop-'))
  const { origin, opened, forge } = await originForge(root)
  await git(origin, 'branch', 'feature-1')
  const config = parseConfig(`
providers: [claude: {}]
repos: { acme/*: {} }
sources: { github: {} }
queue:
  - skill: fix
    deliver: push
    then: { loop: [review, implement], until: { verdict: approve }, max: 2 }
`)
  const plan = planRun({
    config,
    items: [githubPr(1)],
    allowances: { claude: allowance(config.budget, null, 0, config.windows) },
    skills: { builtin: builtinSkills },
  })
  expect(formatPlan(plan)).toMatch(/api#1 .* push +PR 1\n/)
  const verdicts = { 'acme-api-1-review-1': 'changes', 'acme-api-1-review-2': 'approve' }
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

  expect(opened).toEqual([])
  const host = report.results[0]
  expect(host?.outcome).toMatchObject({ kind: 'pushed', branch: 'feature-1', commits: 2 })
  expect(host?.outcome && 'text' in host.outcome && host.outcome.text).toContain(
    'Add rate limits\n\nDone.\n\n## Awaywork chain\n\nLoop: 2 rounds of review ⇄ implement; until held: verdict approve; last verdict approve.',
  )
  const log = await git(origin, 'log', '--format=%s', 'feature-1')
  expect(log.stdout.split('\n')).toEqual([
    'Work on acme-api-1-implement-1',
    'Work on acme-api-1',
    'init',
  ])
})

it('leaves a pushed chain unpublished without a summary in pr.md', async () => {
  const root = await mkdtemp(join(tmpdir(), 'awaywork-push-bare-'))
  const { origin, forge } = await originForge(root)
  await git(origin, 'branch', 'feature-1')
  const config = parseConfig(`
providers: [claude: {}]
repos: { acme/*: {} }
sources: { github: {} }
queue: [{ skill: fix, deliver: push, then: review }]
`)
  const plan = planRun({
    config,
    items: [githubPr(1)],
    allowances: { claude: allowance(config.budget, null, 0, config.windows) },
    skills: { builtin: builtinSkills },
  })
  const blank: Provider = {
    ...committer,
    async *run(job, signal) {
      yield* committer.run(job, signal)
      if (job.unit.deliver === 'push') await writeFile(join(job.dir, '.away/out/pr.md'), ' \n')
    },
  }
  const report = await runUnits({
    config,
    configDir: root,
    plan,
    runId: 'r1',
    runDir: join(root, 'run'),
    dryRun: false,
    providers: { claude: blank },
    sources: { github: fakeSource() as Source },
    forge,
    ctx: { env: {}, log: () => {} },
    watch: () => ({ stop: async () => {} }),
    shortage: async () => undefined,
    skillDirs: { user: join(root, 'none'), builtin: builtinSkillsDir },
  })

  expect(report.results[0]?.outcome).toEqual({
    kind: 'none',
    reason: '1 commit but no summary, not pushed',
    unpublished: true,
  })
  expect((await git(origin, 'log', '--format=%s', 'feature-1')).stdout).toBe('init')
})

it.each([
  ['Fixed the two failing assertions in auth.test.ts.', ''],
  ['Fixed the two failing assertions in auth.test.ts.', '\n\nRan pnpm test: green.'],
])("sums up a push from its summary's first paragraph, which has no title", async (first, rest) => {
  const root = await mkdtemp(join(tmpdir(), 'awaywork-push-summary-'))
  const { origin, forge } = await originForge(root)
  await git(origin, 'branch', 'feature-1')
  const config = parseConfig(`
providers: [claude: {}]
repos: { acme/*: {} }
sources: { github: {} }
queue: [{ skill: fix, deliver: push }]
`)
  const plan = planRun({
    config,
    items: [githubPr(1)],
    allowances: { claude: allowance(config.budget, null, 0, config.windows) },
    skills: { builtin: builtinSkills },
  })
  const summarizer: Provider = {
    ...committer,
    async *run(job, signal) {
      yield* committer.run(job, signal)
      await writeFile(join(job.dir, '.away/out/pr.md'), `${first}${rest}`)
    },
  }
  const report = await runUnits({
    config,
    configDir: root,
    plan,
    runId: 'r1',
    runDir: join(root, 'run'),
    dryRun: false,
    providers: { claude: summarizer },
    sources: { github: fakeSource() as Source },
    forge,
    ctx: { env: {}, log: () => {} },
    watch: () => ({ stop: async () => {} }),
    shortage: async () => undefined,
    skillDirs: { user: join(root, 'none'), builtin: builtinSkillsDir },
  })

  expect(report.results[0]?.outcome?.kind).toBe('pushed')
  expect(report.results[0]?.summary).toBe(first)
  expect(report.results[0]?.files?.sliceBody).toBe('units/acme-api-1/out/pr.md')
})

it("lists a slice's PR body and sums it up when its publish fails", async () => {
  const root = await mkdtemp(join(tmpdir(), 'awaywork-publish-error-'))
  const { forge } = await originForge(root)
  const config = parseConfig(
    'providers: [claude: {}]\nrepos: { acme/*: {} }\nsources: { github: {} }\nqueue: [{ skill: implement }]',
  )
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
    providers: { claude: committer },
    sources: { github: fakeSource() as Source },
    forge: {
      ...forge,
      openPr: async () => {
        throw new Error('gh pr create failed')
      },
    },
    ctx: { env: {}, log: () => {} },
    watch: () => ({ stop: async () => {} }),
    shortage: async () => undefined,
    skillDirs: { user: join(root, 'none'), builtin: builtinSkillsDir },
  })

  const [result] = report.results
  expect(result).toMatchObject({ status: 'error', reason: 'gh pr create failed', summary: 'Done.' })
  expect(result?.outcome).toBeUndefined()
  expect(result?.files).toMatchObject({
    log: 'units/acme-api-1/1-implement/worker.log',
    sliceBody: 'units/acme-api-1/out/pr.md',
  })
})

it('leaves a push the forge refuses unpublished, not an error', async () => {
  const root = await mkdtemp(join(tmpdir(), 'awaywork-push-refused-'))
  const { origin, forge } = await originForge(root)
  await git(origin, 'branch', 'feature-1')
  const config = parseConfig(`
providers: [claude: {}]
repos: { acme/*: {} }
sources: { github: {} }
queue: [{ skill: fix, deliver: push }]
`)
  const plan = planRun({
    config,
    items: [githubPr(1)],
    allowances: { claude: allowance(config.budget, null, 0, config.windows) },
    skills: { builtin: builtinSkills },
  })
  const meanwhile: Provider = {
    ...committer,
    async *run(job, signal) {
      yield* committer.run(job, signal)
      const tree = (await git(origin, 'rev-parse', 'feature-1^{tree}')).stdout
      const moved = await git(origin, 'commit-tree', tree, '-p', 'feature-1', '-m', 'moved')
      await git(origin, 'update-ref', 'refs/heads/feature-1', moved.stdout)
    },
  }
  const runDir = join(root, 'run')
  const report = await runUnits({
    config,
    configDir: root,
    plan,
    runId: 'r1',
    runDir,
    dryRun: false,
    providers: { claude: meanwhile },
    sources: { github: fakeSource() as Source },
    forge,
    ctx: { env: {}, log: () => {} },
    watch: () => ({ stop: async () => {} }),
    shortage: async () => undefined,
    skillDirs: { user: join(root, 'none'), builtin: builtinSkillsDir },
  })

  expect(report.results[0]).toMatchObject({
    status: 'done',
    outcome: { kind: 'none', reason: 'feature-1 moved, not pushed', unpublished: true },
  })
  expect(formatReport(report)).toContain('feature-1 moved, not pushed')
  expect(await readFile(join(runDir, 'units/acme-api-1/out/pr.md'), 'utf8')).toContain(
    'Work on acme-api-1',
  )
  expect((await git(origin, 'log', '--format=%s', 'feature-1')).stdout).toBe('moved\ninit')
})

it('runs setup once per chain, on its clean base before any worker', async () => {
  const root = await mkdtemp(join(tmpdir(), 'awaywork-chain-setup-'))
  const { forge } = await originForge(root)
  const config = parseConfig(`
providers: [claude: {}]
sources: { github: {} }
queue: [{ skill: implement, then: review }]
repos:
  acme/api:
    setup: 'echo "$NPM_TOKEN $(git status --porcelain | wc -l)" >> .away/setup.txt'
    secrets: [NPM_TOKEN]
`)
  const plan = planRun({
    config,
    items: [issue(1), issue(2)],
    allowances: { claude: allowance(config.budget, null, 0, config.windows) },
    skills: { builtin: builtinSkills },
  })
  await runUnits({
    config,
    configDir: root,
    plan,
    runId: 'r1',
    runDir: join(root, 'run'),
    dryRun: false,
    providers: { claude: committer },
    sources: { github: fakeSource() as Source },
    forge,
    ctx: { env: { PATH: process.env.PATH, NPM_TOKEN: 'npm' }, log: () => {} },
    watch: () => ({ stop: async () => {} }),
    shortage: async () => undefined,
    skillDirs: { user: join(root, 'none'), builtin: builtinSkillsDir },
  })

  const setups = await Promise.all(
    ['acme-api-1', 'acme-api-2'].map((id) =>
      readFile(join(root, 'run/units', id, '2-review/setup.txt'), 'utf8'),
    ),
  )
  expect(setups.map((s) => s.replace(/ +/g, ' '))).toEqual(['npm 0\n', 'npm 0\n'])
})

it("suffixes a taken branch, even one without a PR that awaywork didn't push, and carries the name through every step", async () => {
  const root = await mkdtemp(join(tmpdir(), 'awaywork-suffix-'))
  const { opened, forge } = await originForge(root)
  forge.branches.add('acme/api:away/acme-api-1')
  forge.branches.add('acme/api:away/acme-api-1-2')
  forge.heads['acme/api:away/acme-api-1'] = [
    { url: 'https://github.com/acme/api/pull/9', body: 'Mine.' },
  ]
  const other = { url: 'https://github.com/acme/api/pull/8', body: footer('r0', [issue(2)]) }
  forge.heads['acme/api:away/acme-api-1-2'] = [other]
  forge.branches.add('acme/api:away/acme-api-1-3')
  forge.tips['acme/api:away/acme-api-1-3'] = 'Work in progress'
  const config = parseConfig(`
providers: [claude: {}]
repos: { acme/*: {} }
sources: { github: {} }
queue:
  - skill: implement
    then:
      - { loop: [review, fix], until: { verdict: approve }, max: 2 }
      - plan
`)
  const plan = planRun({
    config,
    items: [issue(1)],
    allowances: { claude: allowance(config.budget, quota(0.36), week, config.windows) },
    skills: { builtin: builtinSkills },
  })
  const prompts: string[] = []
  const provider = looper({ 'acme-api-1-review-2': 'approve' })
  const logged: string[] = []
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
    ctx: { env: {}, log: (line) => logged.push(line) },
    watch: () => ({ stop: async () => {} }),
    shortage: async () => undefined,
    skillDirs: { user: join(root, 'none'), builtin: builtinSkillsDir },
  })

  expect(opened.map((pr) => [pr.head, pr.base])).toEqual([['away/acme-api-1-4', '']])
  expect(new Set(report.results.map((u) => u.planned.unit.branch))).toEqual(
    new Set(['away/acme-api-1-4']),
  )
  expect(report.results).toHaveLength(5)
  for (const prompt of prompts)
    expect(prompt).toContain('You are on the new branch `away/acme-api-1-4`')
  expect(logged).toContain(
    'acme-api-1: away/acme-api-1 is taken on acme/api, using away/acme-api-1-4',
  )
})

it('skips a unit awaywork tried on a suffixed branch, one with every name taken, on its own branch without a PR, or that it cannot check', async () => {
  const root = await mkdtemp(join(tmpdir(), 'awaywork-suffix-skip-'))
  const forge = fakeForge()
  for (const n of [1, 3])
    for (const suffix of ['', '-2', '-3', '-4', '-5', '-6', '-7', '-8', '-9', '-10']) {
      forge.branches.add(`acme/api:away/acme-api-${n}${suffix}`)
      forge.heads[`acme/api:away/acme-api-${n}${suffix}`] = [
        { url: 'https://github.com/acme/api/pull/9', body: 'Mine.' },
      ]
    }
  forge.branches.add('acme/api:away/acme-api-5')
  forge.tips['acme/api:away/acme-api-5'] = 'Fix it\n\nAwaywork: r0'
  forge.branches.add('acme/api:away/acme-api-7')
  const { prsOn } = forge
  forge.prsOn = async (repo, branch) => {
    if (branch === 'away/acme-api-7') throw new Error('rate limited')
    return prsOn(repo, branch)
  }
  forge.heads['acme/api:away/acme-api-1-2'] = [
    { url: 'https://github.com/acme/api/pull/8', body: footer('r0', [issue(1)]) },
  ]
  forge.branches.add('acme/api:away/acme-api-11')
  forge.heads['acme/api:away/acme-api-11'] = [
    { url: 'https://github.com/acme/api/pull/11', body: footer('r0', [issue(11)]), merged: true },
    { url: 'https://github.com/acme/api/pull/12', body: footer('r0', [issue(11)]) },
  ]
  forge.branches.add('acme/api:away/acme-api-9')
  forge.heads['acme/api:away/acme-api-9'] = [
    { url: 'https://github.com/acme/api/pull/10', body: footer('r0', [issue(9)]), merged: true },
  ]
  const config = parseConfig(
    'providers: [claude: {}]\nrepos: { acme/*: {} }\nsources: { github: {} }\nqueue: [{ skill: implement }]',
  )
  const plan = planRun({
    config,
    items: [issue(1), issue(3), issue(5), issue(7), issue(11), issue(9)],
    allowances: { claude: allowance(config.budget, null, 0, config.windows) },
    skills: { builtin: builtinSkills },
  })
  const report = await runUnits({
    config,
    configDir: root,
    plan,
    runId: 'r1',
    runDir: join(root, 'run'),
    dryRun: true,
    providers: { claude: worker },
    sources: { github: fakeSource() as Source },
    forge,
    ctx: { env: {}, log: () => {} },
    shortage: async () => undefined,
    skillDirs: { user: join(root, 'none'), builtin: builtinSkillsDir },
  })
  const merged = report.results.at(-1)
  expect(merged?.planned.unit.id).toBe('acme-api-9')
  expect(merged?.planned.unit.branch).toBe('away/acme-api-9-2')
  expect(merged?.status).not.toBe('skipped')
  expect(report.results.slice(0, -1).map((u) => [u.planned.unit.id, u.status, u.reason])).toEqual([
    [
      'acme-api-1',
      'skipped',
      'awaywork tried this in https://github.com/acme/api/pull/8; delete away/acme-api-1-2 to run it again',
    ],
    ['acme-api-3', 'skipped', 'away/acme-api-3 to away/acme-api-3-10 already exist on acme/api'],
    [
      'acme-api-5',
      'skipped',
      'away/acme-api-5 exists on acme/api without a PR; delete it to run again',
    ],
    ['acme-api-7', 'skipped', "couldn't check away/acme-api-7 on acme/api: rate limited"],
    [
      'acme-api-11',
      'skipped',
      'awaywork tried this in https://github.com/acme/api/pull/12; delete away/acme-api-11 to run it again',
    ],
  ])
})

it('stacks a draft PR on an awaywork PR it takes up, and runs setup there without secrets', async () => {
  const root = await mkdtemp(join(tmpdir(), 'awaywork-ours-'))
  const { origin, opened, forge } = await originForge(root)
  await git(origin, 'branch', 'away/acme-api-5')
  const config = parseConfig(`
providers: [claude: {}]
sources: { github: {} }
queue: [{ skill: fix, where: { ours: true, my_unresolved_threads: { not: 0 } } }]
repos:
  acme/api:
    setup: 'echo "$NPM_TOKEN" > .away/setup.txt'
    secrets: [NPM_TOKEN]
`)
  const pr = githubPr(9, { ours: true, unresolved_threads: 1, my_unresolved_threads: 1 })
  const link = { ...pr.linkedPrs[0], branch: 'away/acme-api-5', ours: true } as PrRef
  const plan = planRun({
    config,
    items: [{ ...pr, linkedPrs: [link] }],
    allowances: { claude: allowance(config.budget, null, 0, config.windows) },
    skills: { builtin: builtinSkills },
  })
  await runUnits({
    config,
    configDir: root,
    plan,
    runId: 'r1',
    runDir: join(root, 'run'),
    dryRun: false,
    providers: { claude: committer },
    sources: { github: fakeSource() as Source },
    forge,
    ctx: { env: { PATH: process.env.PATH, NPM_TOKEN: 'npm' }, log: () => {} },
    watch: () => ({ stop: async () => {} }),
    shortage: async () => undefined,
    skillDirs: { user: join(root, 'none'), builtin: builtinSkillsDir },
  })

  expect(opened).toEqual([
    {
      head: 'away/acme-api-9',
      base: 'away/acme-api-5',
      body: expect.stringContaining(`Stacked on ${link.url}: merge that first.`),
    },
  ])
  expect(forge.stacked).toEqual([[link.url, 'https://example.com/acme/api/pull/away/acme-api-9']])
  expect(await readFile(join(root, 'run/units/acme-api-9/1-fix/setup.txt'), 'utf8')).toBe('\n')
})

it("stacks a chain's draft PR on an awaywork PR a rule took up, whichever step committed", async () => {
  const pr = githubPr(9, { ours: true })
  const link = { ...pr.linkedPrs[0], branch: 'away/acme-api-5', ours: true } as PrRef
  const stackedOn = async (then: string) => {
    const { opened } = await loopRun(
      `queue: [{ skill: review, where: { type: pr, ours: true }, then: ${then} }]`,
      [{ ...pr, linkedPrs: [link] }],
      looper({ 'acme-api-9-review-1': 'approve' }),
    )
    return opened.map((o) => [o.head, o.base, o.body.includes(`Stacked on ${link.url}`)])
  }

  expect(await stackedOn('[{ skill: fix, when: { verdict: changes } }, implement]')).toEqual([
    ['away/acme-api-9', 'away/acme-api-5', true],
  ])
  expect(
    await stackedOn('[{ loop: [review, fix], until: { verdict: approve }, max: 1 }, implement]'),
  ).toEqual([['away/acme-api-9', 'away/acme-api-5', true]])
})

it("matches changed against a taken-up awaywork PR's branch, not its own commits", async () => {
  const root = await mkdtemp(join(tmpdir(), 'awaywork-ours-'))
  const { origin, forge } = await originForge(root)
  await git(origin, 'checkout', '-q', '-b', 'away/acme-api-5')
  await mkdir(join(origin, 'src/auth'), { recursive: true })
  await writeFile(join(origin, 'src/auth/a.ts'), 'auth')
  await git(origin, 'add', '.')
  await git(origin, 'commit', '-qm', 'Touch auth')
  await git(origin, 'checkout', '-q', 'main')
  const config = parseConfig(`
providers: [claude: {}]
repos: { acme/*: {} }
sources: { github: {} }
queue:
  - skill: fix
    where: { type: pr, ours: true }
    then: { skill: review, when: { changed: "src/auth/**" } }
`)
  const pr = githubPr(9, { ours: true })
  const link = { ...pr.linkedPrs[0], branch: 'away/acme-api-5', ours: true } as PrRef
  const plan = planRun({
    config,
    items: [{ ...pr, linkedPrs: [link] }],
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
    providers: { claude: committer },
    sources: { github: fakeSource() as Source },
    forge,
    ctx: { env: { PATH: process.env.PATH }, log: () => {} },
    watch: () => ({ stop: async () => {} }),
    shortage: async () => undefined,
    skillDirs: { user: join(root, 'none'), builtin: builtinSkillsDir },
  })

  expect(report.results.map((u) => [u.planned.unit.id, u.status, u.reason])).toEqual([
    ['acme-api-9', 'done', undefined],
    ['acme-api-9-review', 'skipped', `when the branch changes src/auth/** didn't hold`],
  ])
})
