import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execa } from 'execa'
import { expect, it, vi } from 'vitest'
import { formatPlan, formatRun, summarize } from '../src/cli/format.js'
import { parseConfig } from '../src/config/load.js'
import { bin, builtinSkillsDir } from '../src/config/paths.js'
import { recordAttempts } from '../src/core/attempts.js'
import { type Allowance, allowance } from '../src/core/budget.js'
import { footer } from '../src/core/footer.js'
import { planRun, slug } from '../src/core/foreman.js'
import { formatReport, runLine } from '../src/core/report.js'
import { builtinSkills } from '../src/core/skills.js'
import { unitStats } from '../src/core/stats.js'
import type { Forge, Item, Provider, PrRef, Quota, Source } from '../src/core/types.js'
import { namedChains, type RunInput, runUnits } from '../src/worker/units.js'
import { fakeForge } from './fakes/forge.js'
import { fakeItem, githubPr } from './fakes/items.js'
import { fakeProvider } from './fakes/provider.js'
import { fakeSource } from './fakes/source.js'

// publish amends commits, which needs a committer identity even on a bare CI runner
process.env.GIT_COMMITTER_NAME ??= 't'
process.env.GIT_COMMITTER_EMAIL ??= 't@t'

const git = (dir: string, ...args: string[]) =>
  execa(bin('git'), ['-C', dir, '-c', 'user.name=t', '-c', 'user.email=t@t', ...args])

const reset = new Date(2026, 8, 26, 3).getTime() / 1000

const quota = (long: number): Quota => ({
  windows: [
    { name: 'five_hour', span: 'short', used: 0.1, resetsAt: 1790254200 },
    { name: 'seven_day', span: 'long', used: long, resetsAt: reset },
  ],
})

const models: (string | undefined)[] = []
const envs: NodeJS.ProcessEnv[] = []
const loaded = {
  PATH: '/bin',
  FAKE_AGENT_TOKEN: 'own',
  OTHER_AGENT_TOKEN: 'other',
  FAKE_TOKEN: 'src',
  NTFY_TOPIC: 'notify',
}

/** Commits and writes a PR body, or writes a report, as a model would; the week fills to 45%. */
const worker: Provider = {
  ...fakeProvider('claude'),
  async *run(job) {
    models.push(job.model)
    envs.push(job.env)
    const out = join(job.dir, '.away/out')
    if (job.unit.deliver === 'report') {
      await writeFile(join(out, 'report.md'), 'Approve.')
      await writeFile(join(out, 'verdict'), 'Approve\n')
    } else {
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

it('runs, publishes and reports a run', async () => {
  const root = await mkdtemp(join(tmpdir(), 'awaywork-run-'))
  const origin = join(root, 'origin')
  await execa(bin('git'), ['init', '-q', '-b', 'main', origin])
  await git(origin, 'commit', '-q', '--allow-empty', '-m', 'init')
  for (const n of [1, 2, 3]) await git(origin, 'branch', `feature-${n}`)
  const forge = {
    ...fakeForge(),
    clone: async (_repo: string, branch: string, dir: string) => {
      await execa(bin('git'), ['clone', '-q', '--branch', branch, origin, dir])
    },
  }
  forge.branches.add('acme/api:away/acme-api-3')
  forge.heads['acme/api:away/acme-api-3'] = [
    { url: 'https://github.com/acme/api/pull/7', body: footer('r0', [githubPr(3)]) },
  ]

  const config = parseConfig(`
providers: [claude: { model: opus }]
sources: { github: { repos: [acme/*] } }
queue:
  - { skill: fix, where: { checks: failing } }
  - { skill: review, where: { review_requested: true }, model: { claude: sonnet } }
notify: { command: 'true', secrets: [NTFY_TOPIC] }
`)
  const items = [
    githubPr(1, { checks: 'failing' }),
    githubPr(2, { mine: false, review_requested: true }),
    githubPr(3, { checks: 'failing' }),
  ]
  // 03:00 local, inside the 01:00-07:00 window, 3 days before the reset: this run and 3 more.
  const now = reset * 1000 - 3 * 24 * 60 * 60 * 1000
  const allowances = { claude: allowance(config.budget, quota(0.36), now, config.windows) }
  const plan = planRun({ config, items, allowances, skills: { builtin: builtinSkills } })
  const runDir = join(root, 'run')

  const tried = `awaywork tried this in https://github.com/acme/api/pull/7; delete away/acme-api-3 to run it again`
  const report = await runUnits({
    config,
    configDir: root,
    plan,
    runId: '20260925-010000',
    runDir,
    dryRun: false,
    providers: {
      claude: worker,
      codex: { ...fakeProvider('codex'), secrets: ['OTHER_AGENT_TOKEN'] },
    },
    sources: { github: { ...fakeSource(), secrets: () => ['FAKE_TOKEN'] } as Source },
    forge,
    ctx: { env: loaded, log: () => {} },
    watch: () => ({ stop: async () => {} }),
    shortage: async () => undefined,
    skillDirs: { user: join(root, 'none'), builtin: builtinSkillsDir },
  })

  expect(report.results.map((u) => [u.planned.unit.id, u.status, u.outcome ?? u.reason])).toEqual([
    [
      'acme-api-1',
      'done',
      {
        kind: 'pr',
        url: 'https://example.com/acme/api/pull/away/acme-api-1',
        commits: 1,
        head: expect.any(String),
      },
    ],
    ['acme-api-3', 'skipped', tried],
    ['acme-api-2', 'done', { kind: 'report', text: 'Approve.' }],
  ])
  expect(models).toEqual(['opus', 'sonnet'])
  expect(report.results.map((u) => u.baseline?.used)).toEqual([0.36, undefined, 0.45])
  const seen = [
    'PATH',
    'FAKE_AGENT_TOKEN',
    'GH_CONFIG_DIR',
    'GH_TOKEN',
    'GH_ENTERPRISE_TOKEN',
    'TWG_CONFIG_DIR',
    'GIT_CONFIG_GLOBAL',
    'GIT_CONFIG_NOSYSTEM',
  ]
  expect(envs.map((env) => Object.keys(env))).toEqual([seen, seen])
  const unitDir = join(runDir, 'units', 'acme-api-1', '1-fix')
  expect(await readFile(join(unitDir, 'out/pr.md'), 'utf8')).toMatch(/^Fix the build/)
  expect(await readFile(join(runDir, 'units/acme-api-1/out/pr.md'), 'utf8')).toMatch(
    /^Fix the build/,
  )
  expect(await readFile(join(unitDir, 'worker.log'), 'utf8')).toMatch(/Z working\n/)
  expect(existsSync(join(unitDir, 'prompt.md'))).toBe(true)
  expect(existsSync(join(unitDir, 'context/acme-api-1'))).toBe(true)
  expect(existsSync(join(runDir, 'work', 'acme-api-1'))).toBe(false)
  expect(existsSync(join(runDir, 'plugins', 'acme-api-1'))).toBe(false)

  const text = formatReport(report)
  expect(text).toContain(
    '| 1 | [api#1 PR 1](https://github.com/acme/api/pull/1) | fix | claude | done, 5 turns | https://example.com/acme/api/pull/away/acme-api-1 (1 commit) |',
  )
  expect(text).toContain(
    `| 2 | [api#3 PR 3](https://github.com/acme/api/pull/3) | fix | - | skipped | ${tried} |`,
  )
  expect(text).toContain(
    '| 3 | [api#2 PR 2](https://github.com/acme/api/pull/2) | review | claude | done, 5 turns | report below, verdict approve |',
  )
  expect(text).toContain(
    '- claude: seven_day 36% to 45%, ceiling 49.5%; session 10% to 10%, stop at 90%',
  )
  expect(text).toContain(
    '### api#2: PR 2 (review)\n\nhttps://github.com/acme/api/pull/2\n\nApprove.\n\n<details><summary>Full report</summary>\n\nApprove.\n\n</details>',
  )
  expect(formatRun(report)).toContain(
    [
      'Units 3',
      '     item   skill   status         result',
      '  1  api#1  fix     done, 5 turns  https://example.com/acme/api/pull/away/acme-api-1',
      '     Ran the failing test.',
      '  2  api#3  fix     skipped        awaywork tried this in https://github.com/acme/api/pull/7;…',
      '     PR 3',
      '  3  api#2  review  done, 5 turns  report, verdict approve',
      '     Approve.',
      '',
      'Quota',
      '  claude: seven_day 36% to 45%, ceiling 49.5%; session 10% to 10%, stop at 90%',
      '',
      'awaywork report 20260925-010000 --unit <n|key>  shows one',
    ].join('\n'),
  )
  expect(summarize(report, 'report.md').split('\n')[0]).toBe(
    'Run 20260925-010000: 1 draft PR, 1 report, 3 units',
  )
  expect(runLine('20260925-010000', text)).toBe('20260925-010000  3 units, 1 draft PR, 1 report')
  expect(runLine('20260925-020000', undefined)).toBe('20260925-020000  no report')
})

it('reports a run with no provider and a multi-line warning', () => {
  const at = new Date(2026, 9, 12, 22, 34, 18)
  const plan = { queue: [], defaultQueue: true, units: [], skipped: [], allowances: {} }
  const run = { runId: 'r', dryRun: false, startedAt: at, finishedAt: at, plan, results: [] }
  expect(formatReport({ ...run, quotas: {} }, ['source chores: failed\n\nnot set'])).toBe(
    [
      '# Awaywork r',
      '',
      '2026-10-12 22:34:18 to 2026-10-12 22:34:18, local time',
      '',
      '## Warnings (1)',
      '',
      '- source chores: failed',
      '',
      '  not set',
      '',
      '## Units (0)',
      '',
      'None.',
      '',
      '## Quota',
      '',
      'None.',
      '',
    ].join('\n'),
  )
})

it('prepares workspaces without running a worker or context command on a dry run, for one unit', async () => {
  const root = await mkdtemp(join(tmpdir(), 'awaywork-dry-'))
  const forge = {
    ...fakeForge(),
    clone: async (_repo: string, _branch: string, dir: string) => {
      await execa(bin('git'), ['init', '-q', dir])
      await git(dir, 'commit', '-q', '--allow-empty', '-m', 'init')
    },
  }
  const fetched = join(root, 'fetched')
  const config = parseConfig(
    `providers: [claude: {}]\nsources: { github: { repos: [acme/*], context: { command: 'echo > ${fetched}' } } }\nqueue: [{ skill: fix }]`,
  )
  const plan = planRun({
    config,
    items: [githubPr(1), githubPr(2)],
    allowances: { claude: allowance(config.budget, null, 0, config.windows) },
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
    shortage: async () => undefined,
    skillDirs: { user: join(root, 'none'), builtin: builtinSkillsDir },
  }
  const report = await runUnits({ ...input, only: 'acme-api-2' })
  expect(report.results.map((u) => [u.planned.unit.id, u.status])).toEqual([
    ['acme-api-2', 'prepared'],
  ])
  expect(existsSync(join(root, 'run/work/acme-api-2/.away/prompt.md'))).toBe(true)
  expect(existsSync(fetched)).toBe(false)
  for (const only of ['acme/api#2', 'ACME-API-2', 'api#2', 'github:acme/api#2']) {
    const byKey = await runUnits({ ...input, only })
    expect(byKey.results.map((u) => u.planned.unit.id)).toEqual(['acme-api-2'])
  }
  await expect(runUnits({ ...input, only: 'nope' })).rejects.toThrow('"nope" names 0 units')

  const ended = await runUnits({ ...input, until: new Date(0) })
  expect(ended.results.map((u) => u.reason)).toEqual(['the window ended', 'the window ended'])
})

it('names a unit by its exact id, key, source:key or ref only, and refuses a name for two', async () => {
  const config = parseConfig(
    'providers: [claude: {}]\nsources: { github: { repos: [acme/*] } }\nqueue: [{ skill: fix }]',
  )
  const labs = {
    ...githubPr(1),
    id: 'labs-1',
    key: 'acme-labs/api#1',
    url: 'https://github.com/acme-labs/api/pull/1',
    linkedPrs: [],
  }
  const task = fakeItem({
    source: 'tracker',
    key: 'API-1',
    type: 'task',
    fields: { repo: 'acme/api' },
  })
  const plan = planRun({
    config,
    items: [githubPr(1), labs, task],
    allowances: { claude: allowance(config.budget, null, 0, config.windows) },
    skills: { builtin: builtinSkills },
  })
  const named = (name: string) => namedChains(plan, name).map((p) => p.unit.id)
  expect(named('API-1')).toEqual(['api-1'])
  expect(named('acme/api#1')).toEqual(['acme-api-1'])
  expect(named('api#1')).toEqual(['acme-api-1', 'acme-labs-api-1'])
  expect(named('api-1#')).toEqual([])
  await expect(runUnits({ plan, only: 'api#1' } as RunInput)).rejects.toThrow(
    `"api#1" names 2 units in this run's plan, not one`,
  )
})

it('prepares every step of a chain named by one of its steps, in one clone, on a dry run', async () => {
  const root = await mkdtemp(join(tmpdir(), 'awaywork-dry-chain-'))
  const forge = {
    ...fakeForge(),
    clone: async (_repo: string, _branch: string, dir: string) => {
      await execa(bin('git'), ['init', '-q', dir])
      await git(dir, 'commit', '-q', '--allow-empty', '-m', 'init')
    },
  }
  const config = parseConfig(
    'providers: [claude: {}]\nsources: { github: { repos: [acme/*] } }\nqueue: [{ skill: fix, then: review }]',
  )
  const plan = planRun({
    config,
    items: [githubPr(1)],
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
    only: 'acme-api-1-review',
    providers: { claude: worker },
    sources: { github: fakeSource() as Source },
    forge,
    ctx: { env: {}, log: () => {} },
    shortage: async () => undefined,
    skillDirs: { user: join(root, 'none'), builtin: builtinSkillsDir },
  })
  expect(report.results.map((u) => [u.planned.unit.id, u.status, u.step])).toEqual([
    ['acme-api-1', 'prepared', '1-fix'],
    ['acme-api-1-review', 'prepared', '2-review'],
  ])
  const prompt = await readFile(join(root, 'run/units/acme-api-1/2-review/prompt.md'), 'utf8')
  expect(prompt).toContain('This unit is a step of a chain (fix → review)')
})

it('stops a unit still running at the window end and publishes what it left', async () => {
  const root = await mkdtemp(join(tmpdir(), 'awaywork-end-'))
  const origin = join(root, 'origin')
  await execa(bin('git'), ['init', '-q', '-b', 'main', origin])
  await git(origin, 'commit', '-q', '--allow-empty', '-m', 'init')
  const forge = {
    ...fakeForge(),
    clone: async (_repo: string, _branch: string, dir: string) => {
      await execa(bin('git'), ['clone', '-q', origin, dir])
    },
  }
  const config = parseConfig(
    'providers: [claude: {}]\nsources: { github: { repos: [acme/*] } }\nqueue: [{ skill: fix }]',
  )
  const plan = planRun({
    config,
    items: [githubPr(1), githubPr(2)],
    allowances: { claude: allowance(config.budget, null, 0, config.windows) },
    skills: { builtin: builtinSkills },
  })
  vi.useFakeTimers({ toFake: ['Date'] })
  const until = new Date(Date.now() + 100)
  const endless: Provider = {
    ...fakeProvider('claude'),
    async *run(job, signal) {
      await writeFile(join(job.dir, 'fix.txt'), 'half')
      await git(job.dir, 'add', 'fix.txt')
      await git(job.dir, 'commit', '-qm', 'Start the fix')
      await writeFile(join(job.dir, '.away/out/pr.md'), 'Start the fix\n\nUnfinished.')
      vi.setSystemTime(until)
      if (!signal.aborted) await new Promise((ok) => signal.addEventListener('abort', ok))
      yield { type: 'done', ok: false, turns: 1 }
    },
  }
  try {
    const report = await runUnits({
      config,
      configDir: root,
      plan,
      runId: 'r1',
      runDir: join(root, 'run'),
      dryRun: false,
      until,
      providers: { claude: endless },
      sources: { github: fakeSource() as Source },
      forge,
      ctx: { env: {}, log: () => {} },
      watch: () => ({ stop: async () => {} }),
      shortage: async () => undefined,
      skillDirs: { user: join(root, 'none'), builtin: builtinSkillsDir },
    })
    expect(report.results.map((u) => [u.status, u.outcome ?? u.reason])).toEqual([
      [
        'stopped: window ended',
        {
          kind: 'pr',
          url: 'https://example.com/acme/api/pull/away/acme-api-1',
          commits: 1,
          head: expect.any(String),
        },
      ],
      ['skipped', 'the window ended'],
    ])
  } finally {
    vi.useRealTimers()
  }
})

it('ends the run before a unit when the machine is short, launching no worker and counting nothing', async () => {
  const root = await mkdtemp(join(tmpdir(), 'awaywork-short-'))
  const origin = join(root, 'origin')
  await execa(bin('git'), ['init', '-q', '-b', 'main', origin])
  await git(origin, 'commit', '-q', '--allow-empty', '-m', 'init')
  const forge = {
    ...fakeForge(),
    clone: async (_repo: string, _branch: string, dir: string) => {
      await execa(bin('git'), ['clone', '-q', origin, dir])
    },
  }
  const config = parseConfig(
    'providers: [claude: {}]\nsources: { github: { repos: [acme/*] } }\nqueue: [{ skill: fix }]',
  )
  const plan = planRun({
    config,
    items: [1, 2, 3].map((n) => githubPr(n, { updated: '2026-01-01T00:00:00Z' })),
    allowances: { claude: allowance(config.budget, null, 0, config.windows) },
    skills: { builtin: builtinSkills },
  })
  let runs = 0
  const checked: string[] = []
  const report = await runUnits({
    config,
    configDir: root,
    plan,
    runId: 'r1',
    runDir: join(root, 'run'),
    dryRun: false,
    providers: {
      claude: {
        ...worker,
        run: (...args) => {
          runs++
          return worker.run(...args)
        },
      },
    },
    sources: { github: fakeSource() as Source },
    forge,
    ctx: { env: {}, log: () => {} },
    watch: () => ({ stop: async () => {} }),
    shortage: async (dir) => (checked.push(dir) > 1 ? 'disk below 2 GB' : undefined),
    skillDirs: { user: join(root, 'none'), builtin: builtinSkillsDir },
  })
  expect(report.results.map((u) => [u.planned.unit.id, u.status, u.reason])).toEqual([
    ['acme-api-1', 'done', undefined],
    ['acme-api-2', 'skipped', 'disk below 2 GB'],
    ['acme-api-3', 'skipped', 'disk below 2 GB'],
  ])
  expect(runs).toBe(1)
  expect(checked).toEqual(
    ['acme-api-1', 'acme-api-2', 'acme-api-3'].map((id) => join(root, 'run/work', id)),
  )
  expect(Object.keys(recordAttempts({}, report))).toEqual(['github:acme/api#1'])
})

it('runs a chain in one clone, each step on what the one before left, and ends it after a step that committed nothing', async () => {
  const root = await mkdtemp(join(tmpdir(), 'awaywork-chain-'))
  const origin = join(root, 'origin')
  await execa(bin('git'), ['init', '-q', '-b', 'main', origin])
  await git(origin, 'commit', '-q', '--allow-empty', '-m', 'init')
  const base = fakeForge()
  const forge = {
    ...base,
    clone: async (_repo: string, branch: string, dir: string) => {
      await execa(bin('git'), ['clone', '-q', ...(branch ? ['--branch', branch] : []), origin, dir])
    },
    push: async (dir: string, branch: string, opts: { repo: string }) => {
      await git(dir, 'push', '-q', origin, `HEAD:refs/heads/${branch}`)
      await base.push(dir, branch, opts)
    },
  }
  const config = parseConfig(`
providers: [claude: {}]
sources: { github: { repos: [acme/*] } }
queue: [{ skill: implement, where: { type: issue }, then: review }]
`)
  const issue = (n: number) =>
    fakeItem({
      source: 'github',
      key: `acme/api#${n}`,
      type: 'issue',
      fields: { repo: 'acme/api' },
    })
  const plan = planRun({
    config,
    items: [issue(5), issue(6)],
    allowances: { claude: allowance(config.budget, null, 0, config.windows) },
    skills: { builtin: builtinSkills },
  })
  const seen: { prompt: string; files: string[]; diff?: string }[] = []
  const chained: Provider = {
    ...fakeProvider('claude'),
    async *run(job) {
      const previous = join(job.dir, '.away/context/previous')
      seen.push({
        prompt: job.prompt,
        files: await readdir(job.dir),
        diff: await readFile(join(previous, 'diff.patch'), 'utf8').catch(() => undefined),
      })
      const out = join(job.dir, '.away/out')
      if (job.unit.deliver === 'report') await writeFile(join(out, 'report.md'), 'Approve.')
      else if (job.unit.id === 'acme-api-5') {
        await writeFile(join(job.dir, 'fix.txt'), 'fixed')
        await git(job.dir, 'add', 'fix.txt')
        await git(job.dir, 'commit', '-qm', 'Add rate limits')
        await writeFile(join(out, 'pr.md'), 'Add rate limits\n\nRan the tests.')
      } else await writeFile(join(out, 'pr.md'), 'No change\n\n## Triage\nThe red check is flaky.')
      yield { type: 'done', ok: true, turns: 2 }
    },
  }

  const report = await runUnits({
    config,
    configDir: root,
    plan,
    runId: 'r1',
    runDir: join(root, 'run'),
    dryRun: false,
    providers: { claude: chained },
    sources: { github: fakeSource() as Source },
    forge,
    ctx: { env: {}, log: () => {} },
    watch: () => ({ stop: async () => {} }),
    shortage: async () => undefined,
    skillDirs: { user: join(root, 'none'), builtin: builtinSkillsDir },
  })

  const rows = report.results.map((u) => [
    u.planned.unit.id,
    u.status,
    u.outcome ?? u.made ?? u.reason,
  ])
  expect(rows).toEqual([
    [
      'acme-api-5',
      'done',
      {
        kind: 'pr',
        url: 'https://example.com/acme/api/pull/away/acme-api-5',
        commits: 1,
        head: expect.any(String),
      },
    ],
    ['acme-api-5-review', 'done', 'a report'],
    ['acme-api-6', 'done', { kind: 'none', reason: 'nothing' }],
    ['acme-api-6-review', 'skipped', 'acme-api-6 committed nothing'],
  ])
  expect(report.results.map((u) => u.passedOver)).toEqual([undefined, undefined, undefined, true])
  const [five, six] = ['units/acme-api-5', 'units/acme-api-6']
  expect(report.results.map((u) => [u.summary, u.files])).toEqual([
    [
      'Ran the tests.',
      {
        log: `${five}/1-implement/worker.log`,
        diff: `${five}/1-implement/out/diff.patch`,
        sliceBody: `${five}/out/pr.md`,
        sliceDiff: `${five}/out/diff.patch`,
      },
    ],
    ['Approve.', { log: `${five}/2-review/worker.log`, report: `${five}/2-review/out/report.md` }],
    [
      'The red check is flaky.',
      { log: `${six}/1-implement/worker.log`, sliceBody: `${six}/out/pr.md` },
    ],
    [undefined, undefined],
  ])
  const review = seen[1]
  expect(review?.files).toContain('fix.txt')
  expect(review?.diff).toMatch(/^\+\+\+ b\/fix\.txt$/m)
  expect(review?.prompt).toContain(
    'The step before, `implement`, left its output in `.away/context/previous/`',
  )
})

it('runs context and setup before the worker, setup with only its own secrets, none on a foreign PR, not at all on an untrusted one, and skips a unit whose setup fails', async () => {
  const root = await mkdtemp(join(tmpdir(), 'awaywork-setup-'))
  const forge = {
    ...fakeForge(),
    clone: async (_repo: string, branch: string, dir: string) => {
      await execa(bin('git'), ['init', '-q', dir])
      await git(dir, 'commit', '-q', '--allow-empty', '-m', 'init')
      if (branch === 'feature-2') await writeFile(join(dir, 'broken'), '')
    },
  }
  const config = parseConfig(`
providers: [claude: {}]
sources:
  github: { repos: [acme/*], context: { command: 'echo "$AWAYWORK_ITEM_KEY" > "$AWAYWORK_CONTEXT_DIR/ctx.md"' } }
queue: [{ skill: review }]
repos:
  acme/api:
    setup: 'if [ -f broken ]; then echo resolving; echo 404 from registry; exit 3; fi; echo "$NPM_TOKEN,$FAKE_AGENT_TOKEN,$SSH_AUTH_SOCK" > setup.txt'
    secrets: [NPM_TOKEN]
`)
  const plan = planRun({
    config,
    items: [
      githubPr(1),
      githubPr(2),
      githubPr(3, { mine: false }),
      githubPr(4, { mine: false, trusted: false }),
    ],
    allowances: { claude: allowance(config.budget, null, 0, config.windows) },
    skills: { builtin: builtinSkills },
  })
  const setups: string[] = []
  const contexts: string[] = []
  const workerEnvs: NodeJS.ProcessEnv[] = []
  const report = await runUnits({
    config,
    configDir: root,
    plan,
    runId: 'r1',
    runDir: join(root, 'run'),
    dryRun: false,
    providers: {
      claude: {
        ...worker,
        async *run(job) {
          setups.push(await readFile(join(job.dir, 'setup.txt'), 'utf8').catch(() => 'not run'))
          const extra = join(job.dir, '.away/context', slug(job.unit.items[0]?.key ?? ''), 'extra')
          contexts.push(await readFile(join(extra, 'ctx.md'), 'utf8').catch(() => 'not run'))
          workerEnvs.push(job.env)
          await writeFile(join(job.dir, '.away/out/report.md'), 'Approve.')
          yield { type: 'done', ok: true, turns: 1 }
        },
      },
    },
    sources: { github: fakeSource() as Source },
    forge,
    ctx: {
      env: {
        PATH: process.env.PATH,
        FAKE_AGENT_TOKEN: 'own',
        NPM_TOKEN: 'npm',
        SSH_AUTH_SOCK: '/agent.sock',
      },
      log: () => {},
    },
    watch: () => ({ stop: async () => {} }),
    shortage: async () => undefined,
    skillDirs: { user: join(root, 'none'), builtin: builtinSkillsDir },
  })

  expect(setups).toEqual(['npm,,/agent.sock\n', ',,/agent.sock\n', 'not run'])
  expect(contexts).toEqual(['acme/api#1\n', 'acme/api#3\n', 'acme/api#4\n'])
  expect(workerEnvs[0]).not.toHaveProperty('NPM_TOKEN')
  expect(workerEnvs[0]).not.toHaveProperty('SSH_AUTH_SOCK')
  expect(report.results.map((u) => [u.status, u.reason])).toEqual([
    ['done', undefined],
    ['skipped', expect.stringMatching(/^setup failed: .*code 3.*\nresolving\n404 from registry$/s)],
    ['done', undefined],
    ['done', undefined],
  ])
  const prompt = await readFile(join(root, 'run/units/acme-api-1/1-review/prompt.md'), 'utf8')
  expect(prompt).toContain('Setup, already run: `if [ -f broken ]')
  const untrusted = await readFile(join(root, 'run/units/acme-api-4/1-review/prompt.md'), 'utf8')
  expect(untrusted).toContain("Setup, not run because this PR's author isn't trusted")
})

it("gives a worker its step's MCP servers, else its rule's, whose secrets are set, and none on someone else's PR", async () => {
  const root = await mkdtemp(join(tmpdir(), 'awaywork-mcp-'))
  const forge = {
    ...fakeForge(),
    clone: async (_repo: string, _branch: string, dir: string) => {
      await execa(bin('git'), ['init', '-q', dir])
      await git(dir, 'commit', '-q', '--allow-empty', '-m', 'init')
    },
  }
  const config = parseConfig(`
providers: [claude: {}]
budget: { fallback: { units: 8, turns: 60 } }
sources: { github: { repos: [acme/*] } }
mcp:
  db: { command: db-mcp, secrets: [DB_URL] }
  jira: { command: jira-mcp, secrets: [JIRA_TOKEN] }
  sentry: { url: "https://mcp.sentry.dev/mcp", headers: { Authorization: "Bearer \${SENTRY_TOKEN}" }, secrets: [SENTRY_TOKEN] }
queue:
  - skill: fix
    where: { checks: failing }
    mcp: [db]
    deliver: report
    then: [{ skill: plan, mcp: [sentry] }, implement, { skill: review, mcp: [] }]
  - { skill: review, mcp: [sentry, jira] }
`)
  const plan = planRun({
    config,
    items: [
      githubPr(1, { checks: 'failing' }),
      githubPr(2),
      githubPr(3, { mine: false, trusted: false }),
      githubPr(4, { mine: false }),
    ],
    allowances: { claude: allowance(config.budget, null, 0, config.windows) },
    skills: { builtin: builtinSkills },
  })
  const jobs: { unit: string; mcp: string[]; env: string[] }[] = []
  await runUnits({
    config,
    configDir: root,
    plan,
    runId: 'r1',
    runDir: join(root, 'run'),
    dryRun: false,
    providers: {
      claude: {
        ...worker,
        async *run(job) {
          const mcp = Object.keys(job.mcp ?? {})
          jobs.push({ unit: job.unit.id, mcp, env: Object.keys(job.env) })
          await writeFile(join(job.dir, '.away/out/report.md'), 'Done.')
          yield { type: 'done', ok: true, turns: 1 }
        },
      },
    },
    sources: { github: fakeSource() as Source },
    forge,
    ctx: {
      env: { PATH: '/bin', DB_URL: 'db', SENTRY_TOKEN: 'sentry', JIRA_TOKEN: '' },
      log: () => {},
    },
    watch: () => ({ stop: async () => {} }),
    shortage: async () => undefined,
    skillDirs: { user: join(root, 'none'), builtin: builtinSkillsDir },
  })

  const fixed = [
    'GH_CONFIG_DIR',
    'GH_TOKEN',
    'GH_ENTERPRISE_TOKEN',
    'TWG_CONFIG_DIR',
    'GIT_CONFIG_GLOBAL',
    'GIT_CONFIG_NOSYSTEM',
  ]
  const sentry = { mcp: ['sentry'], env: ['PATH', 'SENTRY_TOKEN', ...fixed] }
  expect(jobs).toEqual([
    { unit: 'acme-api-1', mcp: ['db'], env: ['PATH', 'DB_URL', ...fixed] },
    { unit: 'acme-api-1-plan', ...sentry },
    { unit: 'acme-api-1-implement', mcp: ['db'], env: ['PATH', 'DB_URL', ...fixed] },
    { unit: 'acme-api-1-review', mcp: [], env: ['PATH', ...fixed] },
    { unit: 'acme-api-2', ...sentry },
    { unit: 'acme-api-3', mcp: [], env: ['PATH', ...fixed] },
    { unit: 'acme-api-4', mcp: [], env: ['PATH', ...fixed] },
  ])
  const log = (unit: string) =>
    readFile(join(root, `run/units/${unit}/1-review/worker.log`), 'utf8')
  expect(await log('acme-api-2')).toContain('mcp: jira not started, unset: JIRA_TOKEN')
  expect(await log('acme-api-3')).toContain("mcp: sentry, jira not started on someone else's PR")
  expect(await log('acme-api-4')).toContain("mcp: sentry, jira not started on someone else's PR")
})

it('stops a unit at unit_minutes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'awaywork-time-'))
  const forge = {
    ...fakeForge(),
    clone: async (_repo: string, _branch: string, dir: string) => {
      await execa(bin('git'), ['init', '-q', dir])
      await git(dir, 'commit', '-q', '--allow-empty', '-m', 'init')
    },
  }
  const config = parseConfig(
    'limits: { unit_minutes: 5 }\nproviders: [claude: {}]\nsources: { github: { repos: [acme/*] } }\nqueue: [{ skill: fix }]',
  )
  const plan = planRun({
    config,
    items: [githubPr(1)],
    allowances: { claude: allowance(config.budget, null, 0, config.windows) },
    skills: { builtin: builtinSkills },
  })
  const hung: Provider = {
    ...fakeProvider('claude'),
    async *run(_job, signal) {
      vi.advanceTimersByTime(5 * 60_000)
      if (!signal.aborted) await new Promise((ok) => signal.addEventListener('abort', ok))
      yield { type: 'done', ok: false, turns: 1 }
    },
  }
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  try {
    const report = await runUnits({
      config,
      configDir: root,
      plan,
      runId: 'r1',
      runDir: join(root, 'run'),
      dryRun: false,
      providers: { claude: hung },
      sources: { github: fakeSource() as Source },
      forge,
      ctx: { env: {}, log: () => {} },
      watch: () => ({ stop: async () => {} }),
      shortage: async () => undefined,
      skillDirs: { user: join(root, 'none'), builtin: builtinSkillsDir },
    })
    expect(report.results.map((u) => [u.status, u.reason])).toEqual([
      ['stopped: time', 'reached unit_minutes (5)'],
    ])
  } finally {
    vi.useRealTimers()
  }
})

/** Clones from and pushes to a local `origin` on `main`, recording each draft PR it opens. */
async function originForge(root: string) {
  const origin = join(root, 'origin')
  await execa(bin('git'), ['init', '-q', '-b', 'main', origin])
  await git(origin, 'commit', '-q', '--allow-empty', '-m', 'init')
  const opened: { head: string; base: string; body: string }[] = []
  const fake = fakeForge()
  const forge = {
    ...fake,
    clone: async (_repo: string, branch: string, dir: string) => {
      await execa(bin('git'), ['clone', '-q', ...(branch ? ['--branch', branch] : []), origin, dir])
    },
    push: async (dir: string, branch: string, opts: { repo: string }) => {
      await fake.push(dir, branch, opts)
      await git(dir, 'push', '-q', origin, `HEAD:refs/heads/${branch}`)
    },
    fastForward: async (dir: string, branch: string, from: string) => {
      const head = await git(origin, 'rev-parse', `refs/heads/${branch}`)
      if (head.stdout !== from) return `${branch} moved`
      await git(dir, 'push', '-q', origin, `HEAD:refs/heads/${branch}`)
    },
    openPr: async (repo: string, head: string, base: string, bodyFile: string) => {
      opened.push({ head, base, body: await readFile(bodyFile, 'utf8') })
      return `https://example.com/${repo}/pull/${head}`
    },
  }
  return { origin, opened, forge }
}

/** Commits `<unit id>.txt` and writes a PR body, or writes a report. */
const committer: Provider = {
  ...fakeProvider('claude'),
  async *run(job) {
    const out = join(job.dir, '.away/out')
    if (job.unit.deliver === 'report') await writeFile(join(out, 'report.md'), 'Approve.')
    else {
      await writeFile(join(job.dir, `${job.unit.id}.txt`), 'done')
      await git(job.dir, 'add', `${job.unit.id}.txt`)
      await git(job.dir, 'commit', '-qm', `Work on ${job.unit.id}`)
      await writeFile(join(out, 'pr.md'), `Work on ${job.unit.id}\n\nDone.`)
    }
    yield { type: 'done', ok: true, turns: 1 }
  },
}

/** Three days before `quota`'s weekly reset. */
const week = reset * 1000 - 3 * 24 * 60 * 60 * 1000

const issue = (n: number) =>
  fakeItem({
    source: 'github',
    id: String(n),
    key: `acme/api#${n}`,
    type: 'issue',
    fields: { repo: 'acme/api' },
  })

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
    'providers: [claude: {}]\nsources: { github: { repos: [acme/*] } }\nqueue: [{ skill: implement }]',
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
sources: { github: { repos: [acme/*] } }
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
sources: { github: { repos: [acme/*] } }
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
sources: { github: { repos: [acme/*] } }
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
sources: { github: { repos: [acme/*] } }
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
sources: { github: { repos: [acme/*] } }
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
sources: { github: { repos: [acme/*] } }
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
    'providers: [claude: {}]\nsources: { github: { repos: [acme/*] } }\nqueue: [{ skill: implement }]',
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
sources: { github: { repos: [acme/*] } }
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
sources: { github: { repos: [acme/*] } }
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

/** Commits and keeps a PR body current; reviews and QA write a report and a verdict from `verdicts`. */
function looper(verdicts: Record<string, string>, seen: Record<string, string[]> = {}): Provider {
  return {
    ...fakeProvider('claude'),
    async *run(job) {
      const previous = join(job.dir, '.away/context/previous')
      seen[job.unit.id] = (await readdir(previous).catch(() => [])).sort()
      const out = join(job.dir, '.away/out')
      const verdict = verdicts[job.unit.id]
      if (job.unit.deliver === 'report') {
        await writeFile(join(out, 'report.md'), `${job.unit.id} says ${verdict ?? 'nothing'}.`)
        if (verdict) await writeFile(join(out, 'verdict'), `${verdict}\n`)
      } else {
        await writeFile(join(job.dir, `${job.unit.id}.txt`), 'done')
        await git(job.dir, 'add', '.')
        await git(job.dir, 'commit', '-qm', `Work on ${job.unit.id}`)
        await writeFile(join(out, 'pr.md'), 'Add rate limits\n\nDone.')
      }
      yield { type: 'done', ok: true, turns: 1 }
    },
  }
}

it("loops review and fix in the chain's clone until the verdict holds, and reports the chain with its steps under it", async () => {
  const root = await mkdtemp(join(tmpdir(), 'awaywork-loop-'))
  const { opened, forge } = await originForge(root)
  const config = parseConfig(`
providers: [claude: {}]
sources: { github: { repos: [acme/*] } }
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
sources: { github: { repos: [acme/*] } }
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
    'providers: [claude: {}]\nsources: { github: { repos: [acme/*] } }\nqueue: [{ skill: implement }]',
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

it('ends a loop when no provider is left for a round, and publishes what it has', async () => {
  const root = await mkdtemp(join(tmpdir(), 'awaywork-loop-budget-'))
  const { opened, forge } = await originForge(root)
  const config = parseConfig(`
providers: [claude: {}]
sources: { github: { repos: [acme/*] } }
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
sources: { github: { repos: [acme/*] } }
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
sources: { github: { repos: [acme/*] } }
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
sources: { github: { repos: [acme/*] } }
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

it("skips a rule whose quota when doesn't hold, and runs one whose does", async () => {
  const root = await mkdtemp(join(tmpdir(), 'awaywork-when-quota-'))
  const { forge } = await originForge(root)
  const config = parseConfig(`
providers: [claude: {}]
sources: { github: { repos: [acme/*] } }
queue:
  - { skill: review, where: { title: { matches: one } }, deliver: report, when: { runs_until_reset: 1 } }
  - { skill: implement, where: { title: { matches: two } }, when: { headroom: 10% } }
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
  expect(review?.reason).toMatch(/^when the window resets within 1 run didn't hold/)
  expect(implemented?.status).toBe('done')
  expect(logged).toEqual([
    "acme-api-1: skipped, when the window resets within 1 run didn't hold",
    'acme-api-2: implement on claude',
    'acme-api-2: done',
  ])
})

it('records no attempt for a rule whose quota when does not hold', async () => {
  const root = await mkdtemp(join(tmpdir(), 'awaywork-when-quota-'))
  const { forge } = await originForge(root)
  const config = parseConfig(`
providers: [claude: {}]
sources: { github: { repos: [acme/*] } }
queue:
  - skill: implement
    where: { type: issue }
    when: { runs_until_reset: 1 }
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
sources: { github: { repos: [acme/*] } }
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
sources: { github: { repos: [acme/*] } }
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

it('stacks a draft PR on an awaywork PR it takes up, and runs setup there without secrets', async () => {
  const root = await mkdtemp(join(tmpdir(), 'awaywork-ours-'))
  const { origin, opened, forge } = await originForge(root)
  await git(origin, 'branch', 'away/acme-api-5')
  const config = parseConfig(`
providers: [claude: {}]
sources: { github: { repos: [acme/*] } }
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
sources: { github: { repos: [acme/*] } }
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

/** Plans `yaml` for `items` and runs it against a local origin. */
async function loopRun(
  yaml: string,
  items: Item[],
  provider: Provider,
  {
    forge: overrides,
    ...input
  }: Omit<Partial<RunInput>, 'forge'> & { forge?: Partial<Forge> } = {},
) {
  const root = await mkdtemp(join(tmpdir(), 'awaywork-loop-'))
  const { origin, opened, forge } = await originForge(root)
  for (const branch of new Set(items.flatMap((i) => i.linkedPrs.map((pr) => pr.branch))))
    await git(origin, 'branch', branch)
  const config = parseConfig(`providers: [claude: {}]
sources: { github: { repos: [acme/*] } }
${yaml}`)
  const plan = planRun({
    config,
    items,
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
    providers: { claude: provider },
    sources: { github: fakeSource() as Source },
    forge: { ...forge, ...overrides },
    ctx: { env: {}, log: () => {} },
    watch: () => ({ stop: async () => {} }),
    shortage: async () => undefined,
    skillDirs: { user: join(root, 'none'), builtin: builtinSkillsDir },
    ...input,
  })
  return { report, opened, origin }
}

it('tells a step to write the PR body until one wrote it, and to keep it after', async () => {
  const provider = looper({ 'acme-api-1-review-2': 'approve' })
  const prompts: Record<string, string> = {}
  await loopRun(
    `queue:
  - skill: plan
    then: { loop: [implement, review], until: { verdict: approve }, max: 2 }
`,
    [issue(1)],
    {
      ...provider,
      run(job, signal) {
        prompts[job.unit.id] = job.prompt
        return provider.run(job, signal)
      },
    },
  )

  const first = prompts['acme-api-1-implement-1']
  expect(first).toContain('Commit on this branch and write `.away/out/pr.md`, the PR body.')
  expect(first).toContain('The step before, `plan`, left its output in `.away/context/previous/`')
  expect(prompts['acme-api-1-implement-2']).toContain(
    'Commit on this branch and keep `.away/out/pr.md` current: it holds what the chain did so far, the PR body.',
  )
})

it('publishes nothing when interrupted, and retries the chain without counting a failure', async () => {
  const stop = new AbortController()
  const provider = looper({})
  const item = fakeItem({
    source: 'github',
    id: '1',
    key: 'acme/api#1',
    type: 'issue',
    fields: { repo: 'acme/api', updated: '2026-09-01T00:00:00Z' },
  })
  const { report, opened } = await loopRun(
    `queue:
  - skill: plan
    then: { loop: [implement, review], until: { verdict: approve }, max: 2 }
`,
    [item],
    {
      ...provider,
      run(job, signal) {
        if (job.unit.id === 'acme-api-1-review-1') stop.abort()
        return provider.run(job, signal)
      },
    },
    { signal: stop.signal },
  )

  expect(report.results.map((u) => [u.planned.unit.id, u.status])).toEqual([
    ['acme-api-1', 'done'],
    ['acme-api-1-implement-1', 'done'],
    ['acme-api-1-review-1', 'stopped: aborted'],
  ])
  expect(report.results[0]?.outcome).toEqual({
    kind: 'none',
    reason: 'interrupted',
    unpublished: true,
  })
  expect(opened).toEqual([])
  expect(recordAttempts({}, report)).toEqual({})
})

it('lists and sums up the joined report a committing chain published when it committed nothing', async () => {
  const provider = looper({})
  const { report } = await loopRun('queue: [{ skill: plan, then: [implement] }]', [issue(1)], {
    ...provider,
    async *run(job, signal) {
      if (job.unit.deliver === 'report') yield* provider.run(job, signal)
      else {
        await writeFile(
          join(job.dir, '.away/out/pr.md'),
          'No change\n\nThe plan was already done upstream.',
        )
        yield { type: 'done', ok: true, turns: 1 }
      }
    },
  })

  expect(report.results[0]).toMatchObject({
    outcome: { kind: 'report', text: 'acme-api-1 says nothing.' },
    summary: 'acme-api-1 says nothing.',
  })
  expect(report.results[0]?.files?.sliceBody).toBe('units/acme-api-1/out/report.md')
})

it('ends a chain at a step that failed, still reports what it has, and counts a failure', async () => {
  const provider = looper({ 'acme-api-1-review-1': 'changes' })
  const item = fakeItem({
    ...issue(1),
    fields: { repo: 'acme/api', updated: '2026-09-01T00:00:00Z' },
  })
  const { report } = await loopRun(
    `queue:
  - skill: plan
    then: { loop: [review, fix], until: { verdict: approve }, max: 2 }
`,
    [item],
    {
      ...provider,
      async *run(job, signal) {
        if (job.unit.id === 'acme-api-1-fix-1') yield { type: 'done', ok: false, turns: 1 }
        else yield* provider.run(job, signal)
      },
    },
  )

  expect(report.results[0]?.outcome).toMatchObject({ kind: 'report' })
  expect(report.results[0]?.loop).toBe('1 round of review ⇄ fix; acme-api-1-fix-1 failed')
  expect(Object.values(recordAttempts({}, report))).toEqual([
    expect.objectContaining({ skill: 'plan', failed: 1 }),
  ])
})

it("publishes what a chain has at the window's end, and retries it without counting a failure", async () => {
  const provider = looper({ 'acme-api-1-review-1': 'changes' })
  const until = new Date(Date.now() + 60 * 60 * 1000)
  const item = fakeItem({
    ...issue(1),
    fields: { repo: 'acme/api', updated: '2026-09-01T00:00:00Z' },
  })
  const { report } = await loopRun(
    `queue:
  - skill: plan
    then: { loop: [review, fix], until: { verdict: approve }, max: 2 }
`,
    [item],
    {
      ...provider,
      async *run(job, signal) {
        yield* provider.run(job, signal)
        if (job.unit.id === 'acme-api-1-review-1') until.setTime(0)
      },
    },
    { until },
  )

  expect(report.results[0]?.outcome).toMatchObject({ kind: 'report' })
  expect(report.results[2]).toMatchObject({ status: 'skipped', reason: 'the window ended' })
  expect(recordAttempts({}, report)).toEqual({})
})

it("turns the chain's first step into an error when its publish fails, and counts a failure", async () => {
  const item = fakeItem({
    ...issue(1),
    fields: { repo: 'acme/api', updated: '2026-09-01T00:00:00Z' },
  })
  const { report } = await loopRun(
    `queue:
  - { skill: implement, then: review }
`,
    [item],
    looper({}),
    { forge: { push: async () => Promise.reject(new Error('push refused')) } },
  )

  expect(report.results.map((u) => [u.planned.unit.id, u.status, u.reason])).toEqual([
    ['acme-api-1', 'error', 'push refused'],
    ['acme-api-1-review', 'done', undefined],
  ])
  expect(unitStats(report.results).map((s) => s.status)).toEqual(['failed', 'done'])
  expect(recordAttempts({}, report)['github:acme/api#1']).toMatchObject({ failed: 1 })
})

it('counts a failure for a loop host whose publish was refused, though a round reached the window end', async () => {
  const provider = looper({})
  const until = new Date(Date.now() + 60 * 60 * 1000)
  const item = fakeItem({
    ...issue(1),
    fields: { repo: 'acme/api', updated: '2026-09-01T00:00:00Z' },
  })
  const { report } = await loopRun(
    `queue:
  - skill: implement
    then: { loop: [review], until: { verdict: approve }, max: 1 }
`,
    [item],
    {
      ...provider,
      async *run(job, signal) {
        yield* provider.run(job, signal)
        await rm(join(job.dir, '.away/out/pr.md'), { force: true })
        until.setTime(0)
      },
    },
    { until },
  )

  expect(report.results[0]?.outcome).toMatchObject({ kind: 'none', unpublished: true })
  expect(report.results[1]).toMatchObject({ status: 'skipped', reason: 'the window ended' })
  expect(recordAttempts({}, report)['github:acme/api#1']).toMatchObject({ failed: 1 })
})

it('runs the whole loop for a step after it that --unit names', async () => {
  const { report } = await loopRun(
    `queue:
  - skill: implement
    then:
      - { loop: [review, fix], until: { verdict: approve }, max: 2 }
      - plan
`,
    [issue(1), issue(2)],
    looper({ 'acme-api-1-review-1': 'approve' }),
    { only: 'acme-api-1-plan' },
  )

  expect(report.results.map((u) => [u.planned.unit.id, u.status])).toEqual([
    ['acme-api-1', 'done'],
    ['acme-api-1-review-1', 'done'],
    ['acme-api-1-plan', 'done'],
  ])
})

it('ends a chain at a step that threw, naming it, and publishes what it has', async () => {
  const provider = looper({})
  const { report } = await loopRun(
    `queue:
  - skill: implement
    then: { loop: [review, fix], until: { verdict: approve }, max: 2 }
`,
    [issue(1)],
    {
      ...provider,
      async *run(job, signal) {
        yield* provider.run(job, signal)
        if (job.unit.id === 'acme-api-1') throw new Error('crashed')
      },
    },
  )

  expect(report.results.map((u) => [u.planned.unit.id, u.status, u.reason])).toEqual([
    ['acme-api-1', 'error', 'crashed'],
    ['acme-api-1-review-1', 'skipped', 'acme-api-1 error: crashed'],
    ['acme-api-1-fix-1', 'skipped', 'acme-api-1 error: crashed'],
  ])
  expect(report.results[0]?.outcome).toMatchObject({ kind: 'pr', commits: 1 })
})

it('runs a loop right after a loop, and the steps after a loop that a step left nothing in', async () => {
  const provider = looper({})
  const { report, opened } = await loopRun(
    `queue:
  - skill: plan
    then:
      - { loop: [review, fix], until: { verdict: approve }, max: 3 }
      - { loop: implement, until: { verdict: approve }, max: 2 }
      - review
`,
    [issue(1)],
    {
      ...provider,
      async *run(job, signal) {
        if (job.unit.id === 'acme-api-1-fix-1') yield { type: 'done', ok: true, turns: 1 }
        else yield* provider.run(job, signal)
      },
    },
  )

  expect(report.results.map((u) => [u.planned.unit.id, u.status, u.made])).toEqual([
    ['acme-api-1', 'done', 'a report'],
    ['acme-api-1-review-1', 'done', 'a report'],
    ['acme-api-1-fix-1', 'done', 'nothing'],
    ['acme-api-1-implement-1', 'done', '1 commit'],
    ['acme-api-1-implement-2', 'done', '1 commit'],
    ['acme-api-1-review', 'done', 'a report'],
  ])
  expect(report.results[0]?.loop).toBe(
    '1 round of review ⇄ fix; acme-api-1-fix-1 committed nothing; 2 rounds of implement; max 2 rounds reached',
  )
  expect(report.results[0]?.outcome).toMatchObject({ kind: 'pr', commits: 2 })
  expect(opened[0]?.body).toContain(
    'Loop: 1 round of review ⇄ fix; acme-api-1-fix-1 committed nothing.\n\nLoop: 2 rounds of implement; max 2 rounds reached.',
  )
})

it('waits for a verdict written in the loop before `until: { verdict: { not } }` holds', async () => {
  const { report } = await loopRun(
    `queue:
  - skill: implement
    then: { loop: [fix, review], until: { verdict: { not: changes } }, max: 2 }
`,
    [issue(1)],
    looper({ 'acme-api-1-review-1': 'approve' }),
  )

  expect(report.results.map((u) => [u.planned.unit.id, u.status, u.loop])).toEqual([
    ['acme-api-1', 'done', '1 round of fix ⇄ review; until held: verdict not changes'],
    ['acme-api-1-fix-1', 'done', undefined],
    ['acme-api-1-review-1', 'done', undefined],
  ])
})

it('ends a chain whose clone a step broke, fails its publish, and still finishes the run', async () => {
  const provider = looper({})
  const { report, opened } = await loopRun(
    `queue:
  - skill: implement
    then: { loop: [review, fix], until: { verdict: approve }, max: 2 }
`,
    [issue(1)],
    {
      ...provider,
      async *run(job, signal) {
        if (job.unit.id === 'acme-api-1-review-1')
          await git(job.dir, 'checkout', '-q', '--orphan', 'gone')
        yield* provider.run(job, signal)
      },
    },
  )

  expect(report.results.map((u) => [u.planned.unit.id, u.status])).toEqual([
    ['acme-api-1', 'error'],
    ['acme-api-1-review-1', 'error'],
  ])
  expect(report.results[0]?.loop).toMatch(/^1 round of review ⇄ fix; acme-api-1-review-1 error: /)
  expect(report.results[0]?.reason).toMatch(/unknown revision/)
  expect(opened).toEqual([])
})

it("hands a round off without running the clone's diff command or writing through its symlinks", async () => {
  const stop = new AbortController()
  const root = await mkdtemp(join(tmpdir(), 'awaywork-outside-'))
  const marker = join(root, 'ran')
  const outside = join(root, 'outside')
  await writeFile(outside, 'mine\n')
  const provider = looper({ 'acme-api-1-review-1': 'changes' })
  await loopRun(
    `queue:
  - skill: implement
    then: { loop: [review, fix], until: { verdict: approve }, max: 2 }
`,
    [issue(1)],
    {
      ...provider,
      async *run(job, signal) {
        if (job.unit.id === 'acme-api-1-review-1') {
          await writeFile(join(root, 'diff.sh'), `#!/bin/sh\ntouch ${marker}\n`, { mode: 0o755 })
          await git(job.dir, 'config', 'diff.external', join(root, 'diff.sh'))
        }
        yield* provider.run(job, signal)
        if (job.unit.id === 'acme-api-1-fix-1')
          await symlink(outside, join(job.dir, '.away/out/diff.patch'))
      },
    },
    {
      runDir: join(root, 'run'),
      signal: stop.signal,
      ctx: {
        env: {},
        log: (line) => {
          if (line === 'acme-api-1-fix-1: done') stop.abort()
        },
      },
    },
  )

  expect(existsSync(marker)).toBe(false)
  expect(await readFile(outside, 'utf8')).toBe('mine\n')
  const patch = join(root, 'run/units/acme-api-1/3-fix/out/diff.patch')
  expect(await readFile(patch, 'utf8')).toContain('+++ b/acme-api-1-fix-1.txt')
})

it('refuses to publish a loop whose PR body a round turned into a symlink', async () => {
  const root = await mkdtemp(join(tmpdir(), 'awaywork-outside-'))
  const outside = join(root, 'outside')
  await writeFile(outside, 'mine\n')
  const provider = looper({ 'acme-api-1-review-1': 'changes' })
  const { report, opened } = await loopRun(
    `queue:
  - skill: implement
    then: { loop: [review, fix], until: { verdict: approve }, max: 1 }
`,
    [issue(1)],
    {
      ...provider,
      async *run(job, signal) {
        yield* provider.run(job, signal)
        if (job.unit.id === 'acme-api-1-fix-1') {
          const body = join(job.dir, '.away/out/pr.md')
          await rm(body)
          await symlink(outside, body)
        }
      },
    },
  )

  expect(report.results[0]?.status).toBe('error')
  expect(report.results[0]?.reason).toBe('.away/out/pr.md in the clone is a symlink')
  expect(opened).toEqual([])
  expect(await readFile(outside, 'utf8')).toBe('mine\n')
})

it("ends a loop whose clone a round symlinked, before the next round's workspace touches it", async () => {
  const root = await mkdtemp(join(tmpdir(), 'awaywork-outside-'))
  await mkdir(join(root, 'previous'))
  await writeFile(join(root, 'previous', 'keep'), 'mine\n')
  const provider = looper({ 'acme-api-1-review-1': 'changes' })
  const { report } = await loopRun(
    `queue:
  - skill: implement
    then: { loop: [review, fix], until: { verdict: approve }, max: 2 }
`,
    [issue(1)],
    {
      ...provider,
      async *run(job, signal) {
        yield* provider.run(job, signal)
        if (job.unit.id === 'acme-api-1-review-1') {
          await rm(join(job.dir, '.away/context'), { recursive: true })
          await symlink(root, join(job.dir, '.away/context'))
        }
      },
    },
  )

  expect(report.results.map((u) => [u.planned.unit.id, u.status, u.reason])).toEqual([
    ['acme-api-1', 'done', undefined],
    ['acme-api-1-review-1', 'done', undefined],
    ['acme-api-1-fix-1', 'error', '.away/context in the clone is a symlink'],
  ])
  expect(await readFile(join(root, 'previous', 'keep'), 'utf8')).toBe('mine\n')
})

it("keeps awaywork's replay.json and worker.log in the unit dir over the ones a worker wrote", async () => {
  const runDir = join(await mkdtemp(join(tmpdir(), 'awaywork-forged-')), 'run')
  const provider = looper({})
  await loopRun(
    'queue:\n  - skill: implement\n',
    [issue(1)],
    {
      ...provider,
      async *run(job, signal) {
        yield* provider.run(job, signal)
        await writeFile(join(job.dir, '.away/replay.json'), '{"forged":true}')
        await writeFile(join(job.dir, '.away/worker.log'), 'FORGED LOG')
      },
    },
    { runDir },
  )

  const unitDir = join(runDir, 'units/acme-api-1/1-implement')
  const state = JSON.parse(await readFile(join(unitDir, 'replay.json'), 'utf8'))
  expect(state.unit.id).toBe('acme-api-1')
  expect(await readFile(join(unitDir, 'worker.log'), 'utf8')).not.toContain('FORGED')
  expect(existsSync(join(unitDir, 'out/pr.md'))).toBe(true)
})

it('copies nothing from the .away a branch ships into the unit dir', async () => {
  const runDir = join(await mkdtemp(join(tmpdir(), 'awaywork-forged-')), 'run')
  const { report } = await loopRun('queue:\n  - skill: implement\n', [issue(1)], looper({}), {
    runDir,
    forge: {
      clone: async (_repo, _branch, dir) => {
        await execa(bin('git'), ['init', '-q', '-b', 'main', dir])
        await mkdir(join(dir, '.away/out'), { recursive: true })
        for (const file of ['replay.json', 'worker.log', 'out/pr.md'])
          await writeFile(join(dir, '.away', file), 'FORGED')
        await git(dir, 'add', '.')
        await git(dir, 'commit', '-qm', 'init')
      },
    },
  })

  expect(report.results.map((u) => [u.status, u.reason])).toEqual([
    ['error', '.away in the clone comes from the branch, not awaywork'],
  ])
  const unitDir = join(runDir, 'units/acme-api-1/1-implement')
  expect(await readdir(unitDir)).toEqual(['worker.log'])
  expect(await readFile(join(unitDir, 'worker.log'), 'utf8')).toContain('comes from the branch')
})

it('reads past FIFOs a round left as its verdict or report, and finishes the run', async () => {
  const provider = looper({ 'acme-api-1-review-1': 'changes' })
  const { report, opened } = await loopRun(
    `queue:
  - skill: implement
    then: { loop: [review, fix], until: { verdict: approve }, max: 1 }
`,
    [issue(1)],
    {
      ...provider,
      async *run(job, signal) {
        yield* provider.run(job, signal)
        if (job.unit.id === 'acme-api-1-review-1')
          for (const name of ['verdict', 'report.md']) {
            const file = join(job.dir, '.away/out', name)
            await rm(file, { force: true })
            await execa('mkfifo', [file])
          }
      },
    },
  )

  const round = report.results.find((u) => u.planned.unit.id === 'acme-api-1-review-1')
  expect(round?.verdict).toBeUndefined()
  expect(round?.made).toBe('nothing')
  expect(report.results[0]?.loop).toBe(
    '1 round of review ⇄ fix; acme-api-1-review-1 wrote no report',
  )
  expect(opened).toHaveLength(1)
}, 60_000)

it('ends a loop interrupted between rounds, and retries its chain without counting a failure', async () => {
  const stop = new AbortController()
  const { report, opened } = await loopRun(
    `queue:
  - skill: implement
    then: { loop: [review, fix], until: { verdict: approve }, max: 2 }
`,
    [issue(1)],
    looper({ 'acme-api-1-review-1': 'changes' }),
    {
      signal: stop.signal,
      ctx: {
        env: {},
        log: (line) => {
          if (line === 'acme-api-1-review-1: done') stop.abort()
        },
      },
    },
  )

  expect(report.results.map((u) => [u.planned.unit.id, u.status, u.reason])).toEqual([
    ['acme-api-1', 'done', undefined],
    ['acme-api-1-review-1', 'done', undefined],
    ['acme-api-1-fix-1', 'skipped', 'interrupted'],
  ])
  expect(report.results[0]?.loop).toBe('1 round of review ⇄ fix; interrupted')
  expect(report.results[0]?.outcome).toEqual({
    kind: 'none',
    reason: 'interrupted',
    unpublished: true,
  })
  expect(opened).toEqual([])
  expect(recordAttempts({}, report)).toEqual({})
})

it("reads a loop's last verdict in the when of the step after it", async () => {
  const { report } = await loopRun(
    `queue:
  - skill: implement
    then:
      - { loop: [review, fix], until: { verdict: approve }, max: 2 }
      - { skill: plan, when: { verdict: approve } }
`,
    [issue(1)],
    looper({ 'acme-api-1-review-1': 'approve' }),
  )

  expect(report.results.map((u) => [u.planned.unit.id, u.status, u.verdict])).toEqual([
    ['acme-api-1', 'done', undefined],
    ['acme-api-1-review-1', 'done', 'approve'],
    ['acme-api-1-plan', 'done', undefined],
  ])
})

it("doesn't run a check on an untrusted author's PR, or end a loop while the clone has uncommitted changes", async () => {
  const provider = looper({})
  const env = { ctx: { env: { PATH: process.env.PATH }, log: () => {} } }
  const untrusted = (then: string) =>
    loopRun(
      `queue: [{ skill: review, deliver: report, then: ${then} }]\n`,
      [githubPr(4, { mine: false, trusted: false })],
      provider,
      env,
    )
  const refused = "not run on an untrusted author's PR"
  const step = await untrusted(`{ skill: plan, when: { command: 'true' } }`)
  expect(step.report.results[1]).toMatchObject({
    status: 'skipped',
    reason: `when \`true\` passes didn't hold (${refused})`,
    passedOver: true,
  })
  const loop = await untrusted(`{ loop: [fix], until: { command: 'true' }, max: 3 }`)
  expect(loop.report.results[0]?.loop).toBe(
    `1 round of fix; until \`true\` passes not checked: ${refused}`,
  )

  const dirty = await loopRun(
    `queue:
  - skill: implement
    then: { loop: [fix], until: { command: 'test -e fixed.txt' }, max: 1 }
`,
    [issue(1)],
    {
      ...provider,
      async *run(job, signal) {
        yield* provider.run(job, signal)
        if (job.unit.id === 'acme-api-1-fix-1')
          await writeFile(join(job.dir, 'fixed.txt'), 'uncommitted')
      },
    },
    env,
  )
  expect(dirty.report.results[0]?.loop).toBe('1 round of fix; max 1 round reached')
  expect(dirty.opened[0]?.body).toContain('failed: uncommitted changes in the clone')

  const leftForNextStep = await loopRun(
    `queue:
  - skill: implement
    then:
      loop: [fix, { skill: implement, when: { command: 'test -e fixed.txt' } }]
      until: { verdict: approve }
      max: 1
`,
    [issue(1)],
    {
      ...provider,
      async *run(job, signal) {
        yield* provider.run(job, signal)
        if (job.unit.id === 'acme-api-1-fix-1')
          await writeFile(join(job.dir, 'fixed.txt'), 'uncommitted')
      },
    },
    env,
  )
  expect(leftForNextStep.report.results[2]).toMatchObject({
    planned: { unit: { id: 'acme-api-1-implement-1' } },
    status: 'done',
  })
})

it("fences a failed check's output in the PR body past any backticks in it", async () => {
  const { opened } = await loopRun(
    `queue:
  - skill: implement
    then: { loop: [fix], until: { command: "echo '\`\`\`\`'; false" }, max: 1 }
`,
    [issue(1)],
    looper({}),
    { ctx: { env: { PATH: process.env.PATH }, log: () => {} } },
  )

  expect(opened[0]?.body).toContain("`````\n$ echo '````'; false\n````\nfailed:")
})

it("matches changed against the chain's own commits, not another chain's", async () => {
  const { report } = await loopRun(
    `queue:
  - skill: implement
    then: { skill: review, when: { changed: acme-api-1.txt } }
`,
    [issue(1), issue(2)],
    looper({}),
  )

  expect(report.results.map((u) => [u.planned.unit.id, u.status, u.reason])).toEqual([
    ['acme-api-1', 'done', undefined],
    ['acme-api-1-review', 'done', undefined],
    ['acme-api-2', 'done', undefined],
    ['acme-api-2-review', 'skipped', "when the branch changes acme-api-1.txt didn't hold"],
  ])
})

it('matches changed against where the chain started, after a report step', async () => {
  const { report } = await loopRun(
    `queue:
  - skill: implement
    then:
      - review
      - { skill: fix, when: { changed: acme-api-1.txt } }
`,
    [issue(1)],
    looper({}),
  )

  expect(report.results.map((u) => [u.planned.unit.id, u.status])).toEqual([
    ['acme-api-1', 'done'],
    ['acme-api-1-review', 'done'],
    ['acme-api-1-fix', 'done'],
  ])
})

it('ends a loop on a round where every step was passed over, and says so in the PR body', async () => {
  const { report, opened } = await loopRun(
    `queue:
  - skill: implement
    then:
      loop: [{ skill: fix, when: { command: 'false' } }]
      until: { command: 'true' }
      max: 3
`,
    [issue(1)],
    looper({}),
    { ctx: { env: { PATH: process.env.PATH }, log: () => {} } },
  )

  expect(report.results.map((u) => [u.planned.unit.id, u.status])).toEqual([
    ['acme-api-1', 'done'],
    ['acme-api-1-fix-1', 'skipped'],
  ])
  expect(report.results[0]?.loop).toBe("0 rounds of fix; no step's when held")
  expect(opened[0]?.body).toContain(
    "## Awaywork chain\n\nLoop: 0 rounds of fix; no step's when held.",
  )

  const fixedOnce = await loopRun(
    `queue:
  - skill: implement
    then:
      loop: [{ skill: fix, when: { command: 'test ! -e acme-api-1-fix-1.txt' } }]
      until: { command: 'false' }
      max: 3
`,
    [issue(1)],
    looper({}),
    { ctx: { env: { PATH: process.env.PATH }, log: () => {} } },
  )
  expect(fixedOnce.report.results.map((u) => [u.planned.unit.id, u.status])).toEqual([
    ['acme-api-1', 'done'],
    ['acme-api-1-fix-1', 'done'],
    ['acme-api-1-fix-2', 'skipped'],
  ])
  expect(fixedOnce.report.results[0]?.loop).toBe("1 round of fix; no step's when held")
})

it('checks a clone for uncommitted changes beyond what setup and earlier checks left', async () => {
  const { report } = await loopRun(
    `repos: { acme/api: { setup: 'echo x > setup.out' } }
queue:
  - skill: implement
    then:
      - review
      - loop: [fix]
        until: { command: 'touch artifact.out; test -e acme-api-1-fix-2.txt' }
        max: 3
`,
    [issue(1)],
    looper({}),
    { ctx: { env: { PATH: process.env.PATH }, log: () => {} } },
  )

  expect(report.results.map((u) => [u.planned.unit.id, u.status])).toEqual([
    ['acme-api-1', 'done'],
    ['acme-api-1-review', 'done'],
    ['acme-api-1-fix-1', 'done'],
    ['acme-api-1-fix-2', 'done'],
  ])
  expect(report.results[0]?.loop).toMatch(/^2 rounds of fix; until held/)
})

it("doesn't run a nested repo's filter when it checks the clone for uncommitted changes", async () => {
  const ran = join(await mkdtemp(join(tmpdir(), 'awaywork-filter-')), 'ran')
  const provider = looper({})
  const { report } = await loopRun(
    `queue:
  - skill: implement
    then: { loop: [fix], until: { command: 'test ! -e ${ran}' }, max: 1 }
`,
    [issue(1)],
    {
      ...provider,
      async *run(job, signal) {
        yield* provider.run(job, signal)
        if (job.unit.id !== 'acme-api-1-fix-1') return
        const sub = join(job.dir, 'sub')
        const git = (dir: string, ...args: string[]) => execa(bin('git'), ['-C', dir, ...args])
        await git(job.dir, 'init', '-q', 'sub')
        await writeFile(join(sub, 'f'), 'a')
        await git(sub, 'add', 'f')
        await git(sub, '-c', 'user.name=a', '-c', 'user.email=a@a', 'commit', '-qm', 'sub')
        await git(job.dir, 'add', 'sub')
        await git(job.dir, '-c', 'user.name=a', '-c', 'user.email=a@a', 'commit', '-qm', 'sub')
        await writeFile(join(sub, '.gitattributes'), '* filter=evil')
        await git(sub, 'config', 'filter.evil.clean', `touch ${ran}; cat`)
        await writeFile(join(sub, 'f'), 'b')
      },
    },
    { ctx: { env: { PATH: process.env.PATH }, log: () => {} } },
  )

  expect(report.results[0]?.loop).toMatch(/^1 round of fix; until held/)
})

it('skips a when step whose check was interrupted without passing over it, so the chain retries', async () => {
  const stop = new AbortController()
  const started = join(await mkdtemp(join(tmpdir(), 'awaywork-check-')), 'started')
  const watch = setInterval(() => existsSync(started) && stop.abort(), 20)
  const item = fakeItem({
    ...issue(1),
    fields: { repo: 'acme/api', updated: '2026-09-01T00:00:00Z' },
  })
  const { report } = await loopRun(
    `queue:
  - skill: implement
    then: { skill: review, when: { command: 'touch ${started}; sleep 5' } }
`,
    [item],
    looper({}),
    { signal: stop.signal, ctx: { env: { PATH: process.env.PATH }, log: () => {} } },
  ).finally(() => clearInterval(watch))

  expect(report.results[1]).toMatchObject({
    status: 'skipped',
    reason: `when \`touch ${started}; sleep 5\` passes not checked: interrupted`,
  })
  expect(report.results[1]?.passedOver).toBeUndefined()
  expect(recordAttempts({}, report)).toEqual({})
})

it('skips a when step whose check timed out without passing over it, so the chain retries', async () => {
  const real = AbortSignal.timeout.bind(AbortSignal)
  const spy = vi.spyOn(AbortSignal, 'timeout').mockImplementation(() => real(200))
  const item = fakeItem({
    ...issue(1),
    fields: { repo: 'acme/api', updated: '2026-09-01T00:00:00Z' },
  })
  try {
    const { report } = await loopRun(
      `queue:
  - skill: implement
    then: { skill: review, when: { command: '! sleep 30' } }
`,
      [item],
      looper({}),
      { ctx: { env: { PATH: process.env.PATH }, log: () => {} } },
    )

    expect(report.results[1]).toMatchObject({
      status: 'skipped',
      reason: 'when `! sleep 30` passes not checked: timed out after 15 min',
    })
    expect(report.results[1]?.passedOver).toBeUndefined()
    expect(recordAttempts({}, report)).toEqual({})
  } finally {
    spy.mockRestore()
  }
})

it("ends a loop at a refused when, instead of repeating its other steps on code that can't change", async () => {
  const { report, opened } = await loopRun(
    `queue:
  - skill: implement
    deliver: report
    then:
      loop: [review, { skill: fix, when: { command: '! false' } }]
      until: { verdict: approve }
      max: 3
`,
    [githubPr(1, { mine: false, trusted: false })],
    looper({
      'acme-api-1-review-1': 'changes',
      'acme-api-1-review-2': 'changes',
      'acme-api-1-review-3': 'changes',
    }),
  )

  const refused = `when \`! false\` passes didn't hold (not run on an untrusted author's PR)`
  expect(report.results.map((u) => [u.planned.unit.id, u.status, u.reason])).toEqual([
    ['acme-api-1', 'done', undefined],
    ['acme-api-1-review-1', 'done', undefined],
    ['acme-api-1-fix-1', 'skipped', refused],
  ])
  expect(report.results[0]?.loop).toBe(`1 round of review ⇄ fix; ${refused}`)
  expect(opened).toEqual([])
})

it("doesn't run a loop whose first step after a report has a refused when, and finishes the chain", async () => {
  const item = githubPr(1, { mine: false, trusted: false, updated: '2026-09-01T00:00:00Z' })
  const { report, opened } = await loopRun(
    `queue:
  - skill: plan
    deliver: report
    then: { loop: [{ skill: review, when: { command: 'true' } }, implement], until: { verdict: approve }, max: 2 }
`,
    [item],
    looper({}),
  )

  expect(report.results.map((u) => [u.planned.unit.id, u.status, u.passedOver])).toEqual([
    ['acme-api-1', 'done', undefined],
    ['acme-api-1-review-1', 'skipped', true],
  ])
  expect(opened).toEqual([])
  expect(recordAttempts({}, report)['github:acme/api#1']).toEqual({
    runId: 'r1',
    skill: 'plan',
    updated: '2026-09-01T00:00:00Z',
    report: { runId: 'r1', unit: 'acme-api-1', step: '1-plan', skill: 'plan' },
  })
})

it('reports a loop that a refused when ended, and counts the chain finished', async () => {
  const item = githubPr(1, { mine: false, trusted: false, updated: '2026-09-01T00:00:00Z' })
  const { report } = await loopRun(
    `queue:
  - skill: plan
    deliver: report
    then:
      loop: [review, { skill: fix, when: { command: 'true' } }]
      until: { verdict: approve }
      max: 2
`,
    [item],
    looper({ 'acme-api-1-review-1': 'changes' }),
  )

  expect(report.results.map((u) => [u.planned.unit.id, u.status, u.passedOver])).toEqual([
    ['acme-api-1', 'done', undefined],
    ['acme-api-1-review-1', 'done', undefined],
    ['acme-api-1-fix-1', 'skipped', true],
  ])
  expect(report.results[0]?.outcome).toMatchObject({ kind: 'report' })
  expect(recordAttempts({}, report)['github:acme/api#1']).toEqual({
    runId: 'r1',
    skill: 'plan',
    updated: '2026-09-01T00:00:00Z',
    report: { runId: 'r1', unit: 'acme-api-1', step: '2-review', skill: 'review' },
  })
})

it('ends a loop whose when check was interrupted, and retries its chain without counting a failure', async () => {
  const stop = new AbortController()
  const started = join(await mkdtemp(join(tmpdir(), 'awaywork-check-')), 'started')
  const watch = setInterval(() => existsSync(started) && stop.abort(), 20)
  const item = fakeItem({
    ...issue(1),
    fields: { repo: 'acme/api', updated: '2026-09-01T00:00:00Z' },
  })
  const { report, opened } = await loopRun(
    `queue:
  - skill: implement
    then:
      loop: [review, { skill: fix, when: { command: 'touch ${started}; sleep 5' } }]
      until: { verdict: approve }
      max: 2
`,
    [item],
    looper({ 'acme-api-1-review-1': 'changes' }),
    { signal: stop.signal, ctx: { env: { PATH: process.env.PATH }, log: () => {} } },
  ).finally(() => clearInterval(watch))

  expect(report.results[2]).toMatchObject({
    status: 'skipped',
    reason: `when \`touch ${started}; sleep 5\` passes not checked: interrupted`,
  })
  expect(report.results[2]?.passedOver).toBeUndefined()
  expect(report.results[0]?.outcome).toMatchObject({ reason: 'interrupted', unpublished: true })
  expect(opened).toEqual([])
  expect(recordAttempts({}, report)).toEqual({})
})

it('ends a loop whose until check was interrupted, and retries its chain without counting a failure', async () => {
  const stop = new AbortController()
  const started = join(await mkdtemp(join(tmpdir(), 'awaywork-check-')), 'started')
  const watch = setInterval(() => existsSync(started) && stop.abort(), 20)
  const item = fakeItem({
    ...issue(1),
    fields: { repo: 'acme/api', updated: '2026-09-01T00:00:00Z' },
  })
  const { report, opened } = await loopRun(
    `queue:
  - skill: implement
    then: { loop: [review], until: { command: 'touch ${started}; sleep 5' }, max: 2 }
`,
    [item],
    looper({}),
    { signal: stop.signal, ctx: { env: { PATH: process.env.PATH }, log: () => {} } },
  ).finally(() => clearInterval(watch))

  expect(report.results[1]).toMatchObject({
    planned: { unit: { id: 'acme-api-1-review-1' } },
    status: 'done',
  })
  expect(report.results[0]?.outcome).toMatchObject({ reason: 'interrupted', unpublished: true })
  expect(opened).toEqual([])
  expect(recordAttempts({}, report)).toEqual({})
})

it('publishes nothing from a report chain whose last until check was interrupted', async () => {
  const stop = new AbortController()
  const started = join(await mkdtemp(join(tmpdir(), 'awaywork-check-')), 'started')
  const watch = setInterval(() => existsSync(started) && stop.abort(), 20)
  const item = fakeItem({
    ...issue(1),
    fields: { repo: 'acme/api', updated: '2026-09-01T00:00:00Z' },
  })
  const { report } = await loopRun(
    `queue:
  - skill: plan
    then: { loop: [review], until: { command: 'touch ${started}; sleep 5' }, max: 1 }
`,
    [item],
    looper({}),
    { signal: stop.signal, ctx: { env: { PATH: process.env.PATH }, log: () => {} } },
  ).finally(() => clearInterval(watch))

  expect(report.results[0]?.outcome).toMatchObject({ reason: 'interrupted', unpublished: true })
  expect(recordAttempts({}, report)).toEqual({})
})

it("runs every step of a chain on the rule's base, whatever steps were passed over", async () => {
  const bases: Record<string, string> = {}
  const inner = looper({})
  const provider: Provider = {
    ...inner,
    async *run(job, signal) {
      bases[job.unit.id] = job.unit.base
      yield* inner.run(job, signal)
    },
  }
  const item = (n: number, label: string) =>
    fakeItem({ ...issue(n), fields: { repo: 'acme/api', label: [label] } })
  const { report, opened } = await loopRun(
    `queue:
  - { skill: implement, where: { label: first } }
  - skill: review
    deliver: report
    where: { label: second }
    then:
      - { skill: fix, when: { verdict: go } }
      - plan
`,
    [item(1, 'first'), item(2, 'second')],
    provider,
  )

  expect(report.results.map((u) => [u.planned.unit.id, u.status])).toEqual([
    ['acme-api-1', 'done'],
    ['acme-api-2', 'done'],
    ['acme-api-2-fix', 'skipped'],
    ['acme-api-2-plan', 'done'],
  ])
  expect(opened.map((pr) => pr.head)).toEqual(['away/acme-api-1'])
  expect(bases['acme-api-2-plan']).toBe('')
})

it('escapes a pipe in a check command, so the report table keeps its cells', async () => {
  const { report } = await loopRun(
    `queue:
  - skill: implement
    then: { skill: review, when: { command: "git log | grep -q nothing-like-this" } }
`,
    [issue(1)],
    looper({}),
    { ctx: { env: { PATH: process.env.PATH }, log: () => {} } },
  )

  const text = formatReport(report)
  const row = text.split('\n').find((line) => line.startsWith('|  | └ acme-api-1-review |'))
  expect(row).toBe(
    "|  | └ acme-api-1-review | review | claude | skipped | when `git log \\| grep -q nothing-like-this` passes didn't hold (Command failed with exit code 1: 'git log \\| grep -q nothing-like-this') |",
  )
  expect(runLine('r1', text)).toBe('r1  1 unit, 1 draft PR, 0 reports')
})

it("doesn't write a check's log through a symlink a round left in the clone", async () => {
  const root = await mkdtemp(join(tmpdir(), 'awaywork-outside-'))
  const outside = join(root, 'outside')
  await writeFile(outside, 'mine\n')
  const provider = looper({})
  const { report } = await loopRun(
    `queue:
  - skill: implement
    then: { loop: fix, until: { command: 'true' }, max: 1 }
`,
    [issue(1)],
    {
      ...provider,
      async *run(job, signal) {
        yield* provider.run(job, signal)
        if (job.unit.id === 'acme-api-1-fix-1')
          await symlink(outside, join(job.dir, '.away/out/check.log'))
      },
    },
    { ctx: { env: { PATH: process.env.PATH }, log: () => {} } },
  )

  expect(report.results[1]?.status).toBe('error')
  expect(report.results[1]?.reason).toBe('.away/out/check.log in the clone is a symlink')
  expect(await readFile(outside, 'utf8')).toBe('mine\n')
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

it("puts back a loop clone's git config after each worker, and refuses a borrowed object store", async () => {
  const provider = looper({})
  const seen: Record<string, string> = {}
  const { report } = await loopRun(
    `queue:
  - skill: implement
    then: { loop: [review, fix], until: { verdict: approve }, max: 1 }
`,
    [issue(1)],
    {
      ...provider,
      async *run(job, signal) {
        const config = join(job.dir, '.git', 'config')
        seen[job.unit.id] = await readFile(config, 'utf8')
        if (job.unit.id === 'acme-api-1-review-1')
          await writeFile(config, '[core]\n\tsshCommand = touch pwned\n', { flag: 'a' })
        if (job.unit.id === 'acme-api-1-fix-1')
          await writeFile(join(job.dir, '.git', 'objects', 'info', 'alternates'), '/elsewhere\n')
        yield* provider.run(job, signal)
      },
    },
  )

  expect(seen['acme-api-1-fix-1']).toBe(seen['acme-api-1-review-1'])
  expect(report.results[0]?.loop).toBe(
    '1 round of review ⇄ fix; acme-api-1-fix-1 error: .git/objects/info/alternates in the clone points elsewhere',
  )
})

/** Pushes two steps onto PR 1, reports on issue 2, and runs a failing notify. */
const notifyQueue = (out: string) => `queue:
  - { skill: fix, deliver: push, where: { type: pr }, then: implement }
  - { skill: plan, where: { type: issue } }
notify:
  command: echo "$AWAYWORK_EVENT $AWAYWORK_UNIT $AWAYWORK_STATUS $AWAYWORK_PR_URL|$AWAYWORK_REPORT" >> '${out}'; exit 3
`

/** Commits unless it reports, and writes a PR body or a report as its unit delivers. */
const pusher: Provider = {
  ...fakeProvider('claude'),
  async *run(job) {
    if (job.unit.deliver !== 'report') {
      await writeFile(join(job.dir, `${job.unit.id}.txt`), 'done')
      await git(job.dir, 'add', `${job.unit.id}.txt`)
      await git(job.dir, 'commit', '-qm', `Work on ${job.unit.id}`)
    }
    const file = job.unit.deliver === 'report' ? 'report.md' : 'pr.md'
    await writeFile(join(job.dir, '.away/out', file), `Work on ${job.unit.id}\n\nDone.`)
    yield { type: 'done', ok: true, turns: 1 }
  },
}

it("runs notify's unit event once per step with its own output and its chain's PR, and goes on past a failing one", async () => {
  const out = join(await mkdtemp(join(tmpdir(), 'awaywork-notify-')), 'out.txt')
  const logs: string[] = []
  const { report } = await loopRun(notifyQueue(out), [githubPr(1), issue(2)], pusher, {
    ctx: { env: { PATH: process.env.PATH }, log: (line) => logs.push(line) },
  })

  expect(report.results.map((u) => [u.planned.unit.id, u.outcome?.kind])).toEqual([
    ['acme-api-1', 'pushed'],
    ['acme-api-1-implement', undefined],
    ['acme-api-2', 'report'],
  ])
  expect((await readFile(out, 'utf8')).split('\n')).toEqual([
    expect.stringMatching(
      /^unit acme-api-1 done \|\/.+\/run\/units\/acme-api-1\/1-fix\/out\/pr\.md$/,
    ),
    expect.stringMatching(
      /^unit acme-api-1-implement done \|\/.+\/run\/units\/acme-api-1\/2-implement\/out\/pr\.md$/,
    ),
    expect.stringMatching(
      /^unit acme-api-2 done \|\/.+\/run\/units\/acme-api-2\/1-plan\/out\/report\.md$/,
    ),
    '',
  ])
  expect(logs.filter((line) => line.startsWith('notify'))).toEqual([
    expect.stringMatching(/^notify failed for acme-api-1: .*exit code 3/),
    expect.stringMatching(/^notify failed for acme-api-1-implement: /),
    expect.stringMatching(/^notify failed for acme-api-2: /),
  ])
})

it('runs no notify unit event on a dry run, nor once interrupted, past those of the chains that finished', async () => {
  const out = join(await mkdtemp(join(tmpdir(), 'awaywork-notify-')), 'out.txt')
  const items = [githubPr(1), issue(2)]
  await loopRun(notifyQueue(out), items, pusher, { dryRun: true })
  const stop = new AbortController()
  const { report } = await loopRun(notifyQueue(out), items, pusher, {
    signal: stop.signal,
    ctx: {
      env: { PATH: process.env.PATH },
      log: (line) => {
        if (line.startsWith('acme-api-2: ')) stop.abort()
      },
    },
  })

  expect(report.results.map((u) => [u.planned.unit.id, u.status])).toEqual([
    ['acme-api-1', 'done'],
    ['acme-api-1-implement', 'done'],
    ['acme-api-2', 'stopped: aborted'],
  ])
  expect(await readFile(out, 'utf8')).toMatch(
    /^unit acme-api-1 done \|[^\n]+\nunit acme-api-1-implement done \|[^\n]+\n$/,
  )
})

it("runs a chain's notify unit events once it published, with its PR and each step's own output, before the next chain runs", async () => {
  const out = join(await mkdtemp(join(tmpdir(), 'awaywork-notify-loop-')), 'out.txt')
  const yaml = `queue:
  - skill: implement
    then:
      - { loop: [review, fix], until: { verdict: approve }, max: 3 }
      - plan
notify:
  command: echo "$AWAYWORK_UNIT $AWAYWORK_STATUS $AWAYWORK_PR_URL|$AWAYWORK_REPORT|$AWAYWORK_VERDICT|$AWAYWORK_OUT_DIR|$AWAYWORK_ITEM_KEY" >> '${out}'
`
  const provider = looper({ 'acme-api-1-review-1': 'changes', 'acme-api-1-review-2': 'approve' })
  const firedBefore: Record<string, number> = {}
  await loopRun(yaml, [issue(1), issue(2)], {
    ...provider,
    async *run(job, signal) {
      const lines = await readFile(out, 'utf8').catch(() => '')
      firedBefore[job.unit.id] = lines.split('\n').filter(Boolean).length
      yield* provider.run(job, signal)
    },
  })

  expect(firedBefore).toMatchObject({
    'acme-api-1': 0,
    'acme-api-1-review-1': 0,
    'acme-api-1-fix-1': 0,
    'acme-api-1-review-2': 0,
    'acme-api-1-plan': 0,
    'acme-api-2': 5,
  })
  const pr = 'https://example.com/acme/api/pull/away/acme-api-1'
  const lines = (await readFile(out, 'utf8')).trim().split('\n').slice(0, 5)
  expect(lines).toEqual([
    expect.stringMatching(
      `^acme-api-1 done ${pr}\\|/.+/units/acme-api-1/1-implement/out/pr\\.md\\|\\|/.+/units/acme-api-1/1-implement/out\\|acme/api#1$`,
    ),
    expect.stringMatching(
      `^acme-api-1-review-1 done ${pr}\\|/.+/units/acme-api-1/2-review/out/report\\.md\\|changes\\|/.+/units/acme-api-1/2-review/out\\|acme/api#1$`,
    ),
    expect.stringMatching(
      `^acme-api-1-fix-1 done ${pr}\\|/.+/units/acme-api-1/3-fix/out/pr\\.md\\|\\|/.+/units/acme-api-1/3-fix/out\\|acme/api#1$`,
    ),
    expect.stringMatching(
      `^acme-api-1-review-2 done ${pr}\\|/.+/units/acme-api-1/4-review/out/report\\.md\\|approve\\|/.+/units/acme-api-1/4-review/out\\|acme/api#1$`,
    ),
    expect.stringMatching(
      `^acme-api-1-plan done ${pr}\\|/.+/units/acme-api-1/5-plan/out/report\\.md\\|\\|/.+/units/acme-api-1/5-plan/out\\|acme/api#1$`,
    ),
  ])
  const reports = lines.flatMap((line) =>
    line.split('|')[1]?.match(/report\.md$/) ? [line.split('|')[1] as string] : [],
  )
  expect(await Promise.all(reports.map((file) => readFile(file, 'utf8')))).toEqual([
    'acme-api-1-review-1 says changes.',
    'acme-api-1-review-2 says approve.',
    'acme-api-1-plan says nothing.',
  ])
})

/** The PR body, the unit's `out/` in the run dir, what the run printed and what it published. */
async function verified(repoConfig: string, deliver = 'draft_pr', top = '') {
  const lines: string[] = []
  const root = await mkdtemp(join(tmpdir(), 'awaywork-verify-'))
  const { opened, forge } = await originForge(root)
  const config = parseConfig(`
providers: [claude: {}]
sources: { github: { repos: [acme/*] } }
${top}
repos:
  acme/api: { ${repoConfig} }
queue:
  - { skill: implement, deliver: ${deliver} }
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
    ctx: { env: { PATH: process.env.PATH }, log: (line) => lines.push(line) },
    watch: () => ({ stop: async () => {} }),
    shortage: async () => undefined,
    skillDirs: { user: join(root, 'none'), builtin: builtinSkillsDir },
  })

  const out = join(root, 'run', 'units', 'acme-api-1', 'out')
  return { body: opened[0]?.body ?? '', out, lines, outcome: report.results[0]?.outcome }
}

it("publishes a unit whose verify failed with the command's output in the PR body", async () => {
  const { body, out } = await verified("verify: 'echo 2 lint errors; false'")
  expect(await readFile(join(out, 'verify.log'), 'utf8')).toContain('2 lint errors\nfailed: ')
  expect(body).toContain('## Awaywork verify')
  expect(body).toContain('`echo 2 lint errors; false` failed: Command failed with exit code 1')
  expect(body).toContain('2 lint errors')
})

it("leaves the PR body alone when verify passes, and its output out of the run's log", async () => {
  const { body, out, lines } = await verified("verify: 'echo all clean'")
  expect(body).not.toContain('Awaywork verify')
  expect(await readFile(join(out, 'verify.log'), 'utf8')).toBe(
    '$ echo all clean\nall clean\npassed\n',
  )
  expect(lines.join('\n')).not.toContain('all clean')
})

it('opens a deliver: pr PR as a draft when its verify failed, ready for review when it passed', async () => {
  expect((await verified("verify: 'false'", 'pr')).outcome).toMatchObject({
    kind: 'pr',
    draft: 'verify failed',
  })
  expect((await verified("verify: 'true'", 'pr')).outcome).toMatchObject({
    kind: 'pr',
    ready: true,
  })
})

it("doesn't write a failed verify through a link it left for the PR body", async () => {
  const outside = await mkdtemp(join(tmpdir(), 'awaywork-outside-'))
  await writeFile(join(outside, 'pr.md'), 'mine\n')
  const { body } = await verified(
    `verify: 'rm -r .away/out && ln -s ${outside} .away/out && false'`,
  )
  expect(body).toBe('')
  expect(await readFile(join(outside, 'pr.md'), 'utf8')).toBe('mine\n')
})

it('opens a deliver: pr PR as a draft when a gate fired, its card first in the body', async () => {
  const { body, outcome } = await verified(
    "gates: { ids: { changed: '*.txt' }, deps: { changed: package.json } }",
    'pr',
    "gates: { routes: { command: 'echo + GET /exports/vat; exit 1' } }",
  )
  expect(outcome).toMatchObject({ kind: 'pr', draft: 'gates routes, ids fired' })
  expect(body).toMatch(
    /^Add rate limits\n\n## Needs a decision\n\n### Gates \(from scripts\)\n\n- routes: \+ GET \/exports\/vat\n- ids: acme-api-1\.txt\n\n---\n\nDone\.\n\n\nCloses acme\/api#1\n$/,
  )
})

it('keeps a draft_pr PR a draft with the card, says which gates ran when none fired, and adds nothing without gates', async () => {
  const fired = await verified("gates: { ids: { changed: '*.txt' } }")
  expect(fired.outcome).toMatchObject({ kind: 'pr' })
  expect(fired.outcome).not.toHaveProperty('draft')
  expect(fired.body).toContain(
    '## Needs a decision\n\n### Gates (from scripts)\n\n- ids: acme-api-1.txt',
  )
  const quiet = await verified(
    "gates: { deps: { changed: package.json }, ok: { command: 'true' } }",
    'pr',
  )
  expect(quiet.outcome).toMatchObject({ kind: 'pr', ready: true })
  expect(quiet.body).toMatch(/^Add rate limits\n\nGates: none fired \(deps, ok\)\n\n---\n\nDone\./)
  expect((await verified('', 'pr')).body).toMatch(/^Add rate limits\n\nDone\./)
})

it("fires a gate whose command the PR changed, and one that can't run", async () => {
  const { body, outcome } = await verified(
    "gates: { lint: { command: 'sh acme-api-1.txt' }, routes: { command: scripts/missing.sh } }",
    'pr',
  )
  expect(outcome).toMatchObject({ draft: 'gates lint, routes fired' })
  expect(body).toContain('- lint: `acme-api-1.txt` changed, not run\n')
  expect(body).toContain('- routes: Command failed with exit code 127: scripts/missing.sh\n')
})

it("doesn't write the card through a link a gate's command left for the PR body", async () => {
  const outside = await mkdtemp(join(tmpdir(), 'awaywork-outside-'))
  await writeFile(join(outside, 'pr.md'), 'mine\n')
  const { body } = await verified(
    `gates: { swap: { command: 'rm -r .away/out && ln -s ${outside} .away/out && false' } }`,
  )
  expect(body).toBe('')
  expect(await readFile(join(outside, 'pr.md'), 'utf8')).toBe('mine\n')
})

it('pushes onto your PR when a gate fired, with the card atop the summary in the report', async () => {
  const root = await mkdtemp(join(tmpdir(), 'awaywork-push-gate-'))
  const { origin, forge } = await originForge(root)
  await git(origin, 'branch', 'feature-1')
  const config = parseConfig(`
providers: [claude: {}]
sources: { github: { repos: [acme/*] } }
gates: { ids: { changed: '*.txt' } }
queue: [{ skill: fix, deliver: push }]
`)
  const plan = planRun({
    config,
    items: [githubPr(1)],
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

  const [result] = report.results
  expect(result?.outcome).toMatchObject({ kind: 'pushed', gated: 'gate ids fired' })
  expect(result?.outcome && 'text' in result.outcome && result.outcome.text).toBe(
    '## Needs a decision\n\n### Gates (from scripts)\n\n- ids: acme-api-1.txt\n\n---\n\nWork on acme-api-1\n\nDone.',
  )
  expect(formatReport(report)).toContain(
    '1 commit pushed onto feature-1, gate ids fired, report below',
  )
})

/**
 * Runs `yaml` on an origin whose `scripts/gate.sh` is `script`, firing by default, each step's worker doing `act`,
 * which may return its PR body. `items` may add to the origin first; `fallback` gives the providers, in order, and
 * their fallback units, else claude has a quota reading.
 */
async function gated(
  yaml: string,
  act: (dir: string, skill: string, env: NodeJS.ProcessEnv) => Promise<unknown>,
  {
    script = 'echo "+ GET /exports/vat"; exit 1\n',
    items = async () => [issue(1)],
    fallback,
  }: {
    script?: string
    items?: (origin: string) => Promise<Item[]>
    fallback?: Record<string, number>
  } = {},
) {
  const root = await mkdtemp(join(tmpdir(), 'awaywork-gated-'))
  const { origin, opened, forge } = await originForge(root)
  await mkdir(join(origin, 'scripts'))
  await writeFile(join(origin, 'scripts/gate.sh'), script)
  await git(origin, 'add', '.')
  await git(origin, 'commit', '-qm', 'gate')
  const ids = Object.keys(fallback ?? { claude: 0 })
  const config = parseConfig(
    `providers: [${ids.map((id) => `${id}: {}`).join(', ')}]\nsources: { github: { repos: [acme/*] } }\n${yaml}`,
  )
  const allowances = Object.fromEntries(
    ids.map((id): [string, Allowance] => [
      id,
      fallback
        ? { kind: 'fallback', units: fallback[id] ?? 0, turns: 60, reason: 'no quota reading' }
        : allowance(config.budget, null, 0, config.windows),
    ]),
  )
  const plan = planRun({
    config,
    items: await items(origin),
    allowances,
    skills: { builtin: builtinSkills },
  })
  const runs: string[] = []
  const worker = (id: string): Provider => ({
    ...fakeProvider(id),
    async *run(job) {
      runs.push(`${id}:${job.unit.skill}:${job.unit.items[0]?.id}`)
      const body = await act(job.dir, job.unit.skill, job.env)
      const text = typeof body === 'string' ? body : `${job.unit.skill}\n\nDone.`
      // A gate's judge only reports.
      if (job.unit.deliver !== 'report') await writeFile(join(job.dir, '.away/out/pr.md'), text)
      yield { type: 'done', ok: true, turns: 1 }
    },
  })
  const report = await runUnits({
    config,
    configDir: root,
    plan,
    runId: 'r1',
    runDir: join(root, 'run'),
    dryRun: false,
    providers: Object.fromEntries(ids.map((id) => [id, worker(id)])),
    sources: { github: fakeSource() as Source },
    forge,
    ctx: { env: { PATH: process.env.PATH }, log: () => {} },
    watch: () => ({ stop: async () => {} }),
    shortage: async () => undefined,
    skillDirs: { user: join(root, 'none'), builtin: builtinSkillsDir },
  })
  return {
    origin,
    opened,
    runs,
    outcomes: report.results.map((r) => r.outcome),
    statuses: report.results.map((r) => [r.planned.unit.id, r.status]),
  }
}

const commitFile = async (dir: string, file: string, text: string) => {
  await mkdir(join(dir, file, '..'), { recursive: true })
  await writeFile(join(dir, file), text)
  await git(dir, 'add', file)
  await git(dir, 'commit', '-qm', `touch ${file}`)
}

const routesGate = "gates: { routes: { command: 'sh scripts/gate.sh' } }"

it('runs the gate script the chain started with, and fires without running one the worker swapped', async () => {
  const swapped = '- routes: `scripts/gate.sh` changed, not run\n'
  const ran = await gated(`${routesGate}\nqueue: [{ skill: implement, deliver: pr }]`, (dir) =>
    commitFile(dir, 'src/app.ts', 'x'),
  )
  expect(ran.outcomes[0]).toMatchObject({ draft: 'gate routes fired' })
  expect(ran.opened[0]?.body).toContain('- routes: + GET /exports/vat\n')

  const uncommitted = await gated(
    `${routesGate}\nqueue: [{ skill: implement, deliver: pr }]`,
    async (dir) => {
      await commitFile(dir, 'src/app.ts', 'x')
      await git(dir, 'update-index', '--skip-worktree', 'scripts/gate.sh')
      await writeFile(join(dir, 'scripts/gate.sh'), 'exit 0\n')
    },
  )
  expect(uncommitted.outcomes[0]).toMatchObject({ draft: 'gate routes fired' })
  expect(uncommitted.opened[0]?.body).toContain(swapped)

  const byVerify = await gated(
    `repos: { acme/api: { verify: 'sh test.sh' } }\n${routesGate}\nqueue: [{ skill: implement, deliver: pr }]`,
    (dir) => commitFile(dir, 'test.sh', "printf 'exit 0\\n' > scripts/gate.sh\n"),
  )
  expect(byVerify.outcomes[0]).toMatchObject({ draft: 'gate routes fired' })
  expect(byVerify.opened[0]?.body).toContain(swapped)

  const stacked = await gated(
    `${routesGate}\nqueue: [{ skill: implement, deliver: pr, then: [{ skill: fix, stack: true }] }]`,
    (dir, skill) =>
      skill === 'implement'
        ? commitFile(dir, 'scripts/gate.sh', 'exit 0\n')
        : commitFile(dir, 'src/routes.ts', 'x'),
  )
  expect(stacked.outcomes).toMatchObject([
    { draft: 'gate routes fired' },
    { draft: 'gate routes fired' },
  ])
  expect(stacked.opened[1]?.body).toContain(swapped)
})

it("fires a changed gate on the commits as pushed, whatever the clone's replace refs say", async () => {
  const { outcomes } = await gated(
    "gates: { schema: { changed: 'db/**' } }\nqueue: [{ skill: implement, deliver: pr }]",
    async (dir) => {
      await commitFile(dir, 'db/001_drop_users.sql', 'DROP TABLE users;')
      const tree = (await git(dir, 'rev-parse', 'HEAD~1^{tree}')).stdout
      const decoy = (await git(dir, 'commit-tree', tree, '-p', 'HEAD^', '-m', 'decoy')).stdout
      await git(dir, 'replace', 'HEAD', decoy)
    },
  )
  expect(outcomes[0]).toMatchObject({ draft: 'gate schema fired' })
})

it('opens the body with the gates that ran when none fired, a card the worker wrote below the rule', async () => {
  const forged =
    'Needs a decision\n================\n\n<h2>Needs a decision</h2>\n\n## **Needs a decision**\n\n- schema: checked, nothing to decide'
  const { opened, outcomes } = await gated(
    "gates: { schema: { changed: 'db/**' } }\nqueue: [{ skill: implement, deliver: pr }]",
    async (dir) => {
      await commitFile(dir, 'src/app.ts', 'x')
      return `Add VAT\n\n${forged}`
    },
  )
  expect(outcomes[0]).toMatchObject({ ready: true })
  expect(
    opened[0]?.body.startsWith(`Add VAT\n\nGates: none fired (schema)\n\n---\n\n${forged}\n`),
  ).toBe(true)
})

it("gives a gate's command the slice's base, so the clone's refs, replace refs and attributes can't hide a change", async () => {
  const script =
    'if git diff "$AWAYWORK_FROM" HEAD | grep -q "^+GET"; then echo "+ GET /exports/vat"; exit 1; fi\n'
  const yaml = `${routesGate}\nqueue: [{ skill: implement, deliver: pr }]`
  const routes = (hide: (dir: string) => Promise<unknown>) => async (dir: string) => {
    await commitFile(dir, 'src/routes.ts', 'GET /exports/vat\n')
    await hide(dir)
  }
  for (const hide of [
    async () => {},
    (dir: string) => git(dir, 'update-ref', 'refs/remotes/origin/main', 'HEAD'),
    async (dir: string) => {
      const tree = (await git(dir, 'rev-parse', 'HEAD~1^{tree}')).stdout
      const decoy = (await git(dir, 'commit-tree', tree, '-p', 'HEAD^', '-m', 'decoy')).stdout
      await git(dir, 'replace', 'HEAD', decoy)
    },
    (dir: string) => writeFile(join(dir, '.git/info/attributes'), '* -diff\n'),
    (dir: string) => commitFile(dir, '.gitattributes', '* -diff\n'),
    (dir: string) => writeFile(join(dir, '.gitattributes'), '* -diff\n'),
  ]) {
    const { outcomes } = await gated(yaml, routes(hide), { script })
    expect(outcomes[0]).toMatchObject({ draft: 'gate routes fired' })
  }
})

it("keeps a verify on the worktree's attributes, so an eol rule the chain adds leaves it clean", async () => {
  const { outcomes } = await gated(
    `repos: { acme/api: { verify: 'git diff --exit-code' } }\nqueue: [{ skill: implement, deliver: pr }]`,
    async (dir) => {
      await commitFile(dir, '.gitattributes', '* text=auto\n')
      await commitFile(dir, 'crlf.txt', 'a\r\nb\r\n')
    },
  )
  expect(outcomes[0]).toMatchObject({ ready: true })
})

it("runs a gate's command afresh, not taking a when's result on the same commit", async () => {
  const original = 'echo "+ GET /exports/vat"; exit 1\n'
  const { outcomes, statuses } = await gated(
    `${routesGate}\nqueue: [{ skill: implement, deliver: pr, then: [{ skill: fix, when: { command: 'sh scripts/gate.sh' } }] }]`,
    async (dir, skill) => {
      if (skill === 'fix') return writeFile(join(dir, 'scripts/gate.sh'), original)
      await commitFile(dir, 'src/app.ts', 'x')
      await git(dir, 'update-index', '--skip-worktree', 'scripts/gate.sh')
      await writeFile(join(dir, 'scripts/gate.sh'), 'exit 0\n')
    },
  )
  expect(statuses[1]).toEqual(['acme-api-1-fix', 'done'])
  expect(outcomes[0]).toMatchObject({ draft: 'gate routes fired' })
})

it('compares the gate scripts of an awaywork PR a rule took up with where it left the default branch', async () => {
  const items = async (origin: string) => {
    await git(origin, 'checkout', '-q', '-b', 'away/acme-api-5')
    await writeFile(join(origin, 'scripts/gate.sh'), 'exit 0\n')
    await git(origin, 'commit', '-qam', 'Swap the gate')
    await git(origin, 'checkout', '-q', 'main')
    const pr = githubPr(9, { ours: true })
    const link = { ...pr.linkedPrs[0], branch: 'away/acme-api-5', ours: true } as PrRef
    return [{ ...pr, linkedPrs: [link] }]
  }
  const { opened, outcomes } = await gated(
    `${routesGate}\nqueue: [{ skill: fix, where: { type: pr, ours: true }, deliver: pr }]`,
    (dir) => commitFile(dir, 'src/app.ts', 'x'),
    { items },
  )
  expect(outcomes[0]).toMatchObject({ draft: 'gate routes fired' })
  expect(opened[0]?.body).toContain('- routes: `scripts/gate.sh` changed, not run\n')
})

it('diffs a when: { changed } from where the chain started as cloned, wherever the worker moves origin', async () => {
  const { statuses } = await gated(
    "queue: [{ skill: implement, deliver: pr, then: [{ skill: fix, when: { changed: 'src/**' } }] }]",
    async (dir, skill) => {
      if (skill === 'fix') return
      await commitFile(dir, 'src/app.ts', 'x')
      await git(dir, 'update-ref', 'refs/remotes/origin/main', 'HEAD')
    },
  )
  expect(statuses).toEqual([
    ['acme-api-1', 'done'],
    ['acme-api-1-fix', 'done'],
  ])
})

const riskGate = 'gates: { risk: { skill: judge } }'

/** Each step commits `src/app.ts`, and the gate's judge does `judge` in the clone. */
const judgedBy = (judge: (dir: string) => Promise<unknown>) => (dir: string, skill: string) =>
  skill === 'judge' ? judge(dir) : commitFile(dir, 'src/app.ts', 'x')

const verdict =
  (word: string, report = '') =>
  async (dir: string) => {
    await writeFile(join(dir, '.away/out/verdict'), `${word}\n`)
    await writeFile(join(dir, '.away/out/report.md'), report)
  }

it("drafts a deliver: pr PR when its judge fires, the report's lines in the card's Judge part", async () => {
  let prompt = ''
  const { opened, outcomes } = await gated(
    `${riskGate}\nqueue: [{ skill: implement, deliver: pr }]`,
    judgedBy(async (dir) => {
      prompt = await readFile(join(dir, '.away/prompt.md'), 'utf8')
      await verdict('fires', '- VAT rounding moved from the invoice total to each line\n')(dir)
    }),
  )
  expect(outcomes[0]).toMatchObject({ kind: 'pr', draft: 'gate risk fired' })
  expect(opened[0]?.body).toMatch(
    /^implement\n\n## Needs a decision\n\n### Judge\n\n- risk: VAT rounding moved from the invoice total to each line\n\n---\n\nDone\./,
  )
  expect(prompt).toMatch(/You judge the commits on this branch since `[0-9a-f]{40}`/)
  expect(prompt).toContain('# Judge')
})

it("can't clear a script's gate: a judge that doesn't fire adds nothing, and its gate is listed when none fired", async () => {
  const quiet = await gated(
    `${riskGate}\nqueue: [{ skill: implement, deliver: pr }]`,
    judgedBy(verdict('clear', '- nothing to decide')),
  )
  expect(quiet.outcomes[0]).toMatchObject({ ready: true })
  expect(quiet.opened[0]?.body).toMatch(/^implement\n\nGates: none fired \(risk\)\n\n---\n\nDone\./)

  const scripted = await gated(
    `${routesGate}\nrepos: { acme/api: { gates: { routes: { skill: judge } } } }\nqueue: [{ skill: implement, deliver: pr }]`,
    judgedBy(verdict('clear', 'routes: reviewed, safe')),
  )
  expect(scripted.outcomes[0]).toMatchObject({ draft: 'gate routes fired' })
  expect(scripted.opened[0]?.body).toContain(
    '## Needs a decision\n\n### Gates (from scripts)\n\n- routes: + GET /exports/vat\n\n---\n\nDone.',
  )
})

it('drops what the judge changed and fires its gate, publishing the steps’ commits and body', async () => {
  const { origin, opened, outcomes } = await gated(
    `${riskGate}\nqueue: [{ skill: implement, deliver: pr }]`,
    judgedBy(async (dir) => {
      await commitFile(dir, 'src/judged.ts', 'x')
      await writeFile(join(dir, '.away/out/pr.md'), 'implement\n\nReviewed: safe.')
      await writeFile(join(dir, 'src/app.ts'), 'y')
      await verdict('clear')(dir)
    }),
  )
  expect(outcomes[0]).toMatchObject({ kind: 'pr', commits: 1, draft: 'gate risk fired' })
  expect(opened[0]?.body).toContain(
    '### Judge\n\n- risk: the judge changed the clone; awaywork dropped its changes\n\n---\n\nDone.',
  )
  expect(opened[0]?.body).not.toContain('Reviewed')
  const tip = outcomes[0]?.kind === 'pr' ? outcomes[0].head : ''
  const files = (await git(origin, 'ls-tree', '-r', '--name-only', tip)).stdout
  expect(files).toContain('src/app.ts')
  expect(files).not.toContain('src/judged.ts')
  expect((await git(origin, 'show', `${tip}:src/app.ts`)).stdout).toBe('x')
})

it("fires the gate when its judge can't run", async () => {
  const { opened, outcomes } = await gated(
    `${riskGate}\nqueue: [{ skill: implement, deliver: pr }]`,
    judgedBy(async () => {
      throw new Error('the provider fell over')
    }),
  )
  expect(outcomes[0]).toMatchObject({ draft: 'gate risk fired' })
  expect(opened[0]?.body).toContain("- risk: judge didn't run: the provider fell over\n")
})

it("shows the judge the slice as pushed, whatever the steps did to the clone's replace refs, git config and attributes", async () => {
  for (const hide of [
    async (dir: string) => {
      const tree = (await git(dir, 'rev-parse', 'HEAD~1^{tree}')).stdout
      const decoy = (await git(dir, 'commit-tree', tree, '-p', 'HEAD^', '-m', 'decoy')).stdout
      await git(dir, 'replace', 'HEAD', decoy)
    },
    (dir: string) =>
      writeFile(join(dir, '.away/gitconfig'), '[diff]\n\texternal = true\n', { flag: 'a' }),
    (dir: string) => writeFile(join(dir, '.gitattributes'), '* -diff\n'),
  ]) {
    let stepEnv: NodeJS.ProcessEnv = {}
    const { outcomes } = await gated(
      `${riskGate}\nqueue: [{ skill: implement, deliver: pr }]`,
      async (dir, skill, env) => {
        if (skill !== 'judge') {
          stepEnv = env
          await commitFile(dir, 'db/001.sql', 'DROP TABLE users;\n')
          return hide(dir)
        }
        const diff = await execa(bin('git'), ['diff', env.AWAYWORK_FROM ?? '', 'HEAD'], {
          cwd: dir,
          env,
          extendEnv: false,
        })
        await verdict(diff.stdout.includes('+DROP TABLE') ? 'fires' : 'clear', 'drops users')(dir)
      },
    )
    expect(outcomes[0]).toMatchObject({ draft: 'gate risk fired' })
    expect(stepEnv.GIT_CONFIG_GLOBAL).toMatch(/\.away\/gitconfig$/)
    expect(stepEnv).not.toHaveProperty('GIT_NO_REPLACE_OBJECTS')
    expect(stepEnv).not.toHaveProperty('GIT_ATTR_SOURCE')
  }
})

it('judges a slice on a provider that ran its steps without a fallback unit of its own, and on no other', async () => {
  const { runs } = await gated(
    `${riskGate}\nqueue: [{ skill: implement, deliver: pr }]`,
    judgedBy(verdict('clear')),
    { items: async () => [issue(1), issue(2), issue(3)], fallback: { codex: 1, claude: 5 } },
  )
  expect(runs).toEqual([
    'codex:implement:1',
    'codex:judge:1',
    'claude:implement:2',
    'claude:judge:2',
    'claude:implement:3',
    'claude:judge:3',
  ])
})

it('pushes onto your PR when its judge fired, the card atop the summary in the report', async () => {
  const { outcomes } = await gated(
    `${riskGate}\nqueue: [{ skill: fix, deliver: push }]`,
    judgedBy(verdict('fires', 'the export format changed → its consumers decide')),
    {
      items: async (origin) => {
        await git(origin, 'branch', 'feature-1')
        return [githubPr(1)]
      },
    },
  )
  expect(outcomes[0]).toMatchObject({ kind: 'pushed', gated: 'gate risk fired' })
  expect(outcomes[0]?.kind === 'pushed' && outcomes[0].text).toBe(
    '## Needs a decision\n\n### Judge\n\n- risk: the export format changed → its consumers decide\n\n---\n\nfix\n\nDone.',
  )
})

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
sources: { github: { repos: [acme/*] } }
queue:
  - ${rule}
${repos}
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
    '{ skill: fix, where: { checks: failing }, model: { claude: [sonnet, opus] }, when: { headroom: 10% } }',
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
