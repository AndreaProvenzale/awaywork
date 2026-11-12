import { existsSync } from 'node:fs'
import { mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execa } from 'execa'
import { expect, it, vi } from 'vitest'
import { formatRun, summarize } from '../src/cli/format/report.js'
import { parseConfig } from '../src/config/load.js'
import { bin, builtinSkillsDir } from '../src/config/paths.js'
import { recordAttempts } from '../src/core/attempts.js'
import { allowance } from '../src/core/budget.js'
import { footer } from '../src/core/footer.js'
import { planRun, slug } from '../src/core/foreman.js'
import { formatReport, runLine } from '../src/core/report.js'
import { builtinSkills } from '../src/core/skills.js'
import type { Provider, Source } from '../src/core/types.js'
import { namedChains, type RunInput, runUnits } from '../src/worker/units.js'
import { fakeForge } from './fakes/forge.js'
import { fakeItem, githubPr } from './fakes/items.js'
import { fakeProvider } from './fakes/provider.js'
import { fakeSource } from './fakes/source.js'
import { envs, git, models, quota, reset, worker } from './fakes/units.js'

const loaded = {
  PATH: '/bin',
  FAKE_AGENT_TOKEN: 'own',
  OTHER_AGENT_TOKEN: 'other',
  FAKE_TOKEN: 'src',
  NTFY_TOPIC: 'notify',
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
repos: { acme/*: {} }
sources: { github: {} }
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
    '- claude: seven_day 36% to 45%, ceiling 63.2%; session 10% to 10%, stop at 90%',
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
      '  claude: seven_day 36% to 45%, ceiling 63.2%; session 10% to 10%, stop at 90%',
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

it('reports the moves held on posts you approved, made before any unit, and those that failed', () => {
  const at = new Date(2026, 9, 12, 22, 34, 18)
  const moved = [
    { item: 'linear:NIG-21', to: 'In Progress' },
    { item: 'jira:ENG-7', to: 'Ready', failed: 'no transition to Ready' },
  ]
  const plan = { queue: [], defaultQueue: true, units: [], skipped: [], allowances: {}, moved }
  const run = { runId: 'r', dryRun: false, startedAt: at, finishedAt: at, plan, results: [] }
  expect(formatReport({ ...run, quotas: {} })).toContain(
    [
      '## Held moves (2)',
      '',
      '- on_done moved NIG-21 to "In Progress", its post approved',
      `- on_done couldn't move ENG-7 to "Ready": no transition to Ready, its post approved`,
      '',
      '## Units (0)',
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
    `providers: [claude: {}]\nrepos: { acme/*: {} }\nsources: { github: { context: { command: 'echo > ${fetched}' } } }\nqueue: [{ skill: fix }]`,
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
    'providers: [claude: {}]\nrepos: { acme/*: {} }\nsources: { github: {} }\nqueue: [{ skill: fix }]',
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
    'providers: [claude: {}]\nrepos: { acme/*: {} }\nsources: { github: {} }\nqueue: [{ skill: fix, then: review }]',
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
    'providers: [claude: {}]\nrepos: { acme/*: {} }\nsources: { github: {} }\nqueue: [{ skill: fix }]',
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
    'providers: [claude: {}]\nrepos: { acme/*: {} }\nsources: { github: {} }\nqueue: [{ skill: fix }]',
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
repos: { acme/*: {} }
sources: { github: {} }
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
  github: { context: { command: 'echo "$AWAYWORK_ITEM_KEY" > "$AWAYWORK_CONTEXT_DIR/ctx.md"' } }
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
repos: { acme/*: {} }
sources: { github: {} }
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
    'limits: { unit_minutes: 5 }\nproviders: [claude: {}]\nrepos: { acme/*: {} }\nsources: { github: {} }\nqueue: [{ skill: fix }]',
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
