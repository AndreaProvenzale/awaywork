import { existsSync } from 'node:fs'
import { mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execa } from 'execa'
import { expect, it, vi } from 'vitest'
import { formatReportForTerminal } from '../src/cli/format.js'
import { parseConfig } from '../src/config/load.js'
import { builtinSkillsDir } from '../src/config/paths.js'
import { allowance } from '../src/core/budget.js'
import { planNight } from '../src/core/foreman.js'
import { formatReport, runLine, summarize } from '../src/core/report.js'
import { builtinSkills } from '../src/core/skills.js'
import type { Provider, Quota, Source } from '../src/core/types.js'
import { runNight } from '../src/worker/night.js'
import { fakeForge } from './fakes/forge.js'
import { fakeItem, githubPr } from './fakes/items.js'
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

const models: (string | undefined)[] = []
const envs: NodeJS.ProcessEnv[] = []
const loaded = {
  PATH: '/bin',
  FAKE_AGENT_TOKEN: 'own',
  CODEX_AUTH_JSON: 'other',
  FAKE_TOKEN: 'src',
  NTFY_TOPIC: 'notify',
}

/** Commits and writes a PR body, or writes a report, as a model would; the week fills to 45%. */
const worker: Provider = {
  ...fakeProvider('claude'),
  async *run(job) {
    models.push(job.model)
    envs.push(job.env)
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
providers: [claude: { model: opus }]
sources: { github: { repos: [acme/*] } }
queue:
  - { skill: fix-ci, where: { checks: failing } }
  - { skill: review, where: { review_requested: true }, model: { claude: sonnet } }
notify: { command: 'true', secrets: [NTFY_TOPIC] }
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
    providers: {
      claude: worker,
      codex: { ...fakeProvider('codex'), secrets: ['CODEX_AUTH_JSON'] },
    },
    sources: { github: { ...fakeSource(), secrets: () => ['FAKE_TOKEN'] } as Source },
    forge,
    ctx: { env: loaded, log: () => {} },
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
  expect(models).toEqual(['opus', 'sonnet'])
  const seen = ['PATH', 'FAKE_AGENT_TOKEN', 'GH_CONFIG_DIR']
  expect(envs.map((env) => Object.keys(env))).toEqual([seen, seen])
  const unitDir = join(runDir, 'units', 'acme-api-1')
  expect(await readFile(join(unitDir, 'out/pr.md'), 'utf8')).toMatch(/^Fix the build/)
  expect(await readFile(join(unitDir, 'worker.log'), 'utf8')).toMatch(/Z working\n/)
  expect(existsSync(join(unitDir, 'prompt.md'))).toBe(true)
  expect(existsSync(join(unitDir, 'context/acme-api-1'))).toBe(true)
  expect(existsSync(join(runDir, 'work', 'acme-api-1'))).toBe(false)
  expect(existsSync(join(runDir, 'plugins', 'acme-api-1'))).toBe(false)

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
  const shown = formatReportForTerminal(text)
  expect(shown).toContain(
    [
      '#  Unit        Skill   Provider  Status         Result',
      '1  acme-api-1  fix-ci  claude    done, 5 turns  https://example.com/acme/api/pull/night/acme-api-1 (1 commits)',
      '2  acme-api-3  fix-ci  -         skipped        night/acme-api-3 already exists on acme/api',
    ].join('\n'),
  )
  expect(shown).not.toContain('|')
  expect(shown.startsWith(text.slice(0, text.indexOf('| #')))).toBe(true)
  expect(shown.endsWith(text.slice(text.indexOf('\n## Quota')))).toBe(true)
  expect(summarize(report, 'report.md').split('\n')[0]).toBe(
    'Run 20260925-010000: 1 draft PRs, 1 reports, 3 units',
  )
  expect(runLine('20260925-010000', text)).toBe('20260925-010000  3 units, 1 draft PRs, 1 reports')
  expect(runLine('20260925-020000', undefined)).toBe('20260925-020000  no report')
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

it('runs a chained unit with the units it follows, which a dry run leaves nothing to', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nightshift-dry-chain-'))
  const forge = {
    ...fakeForge(),
    clone: async (_repo: string, _branch: string, dir: string) => {
      await execa('git', ['init', '-q', dir])
      await git(dir, 'commit', '-q', '--allow-empty', '-m', 'init')
    },
  }
  const config = parseConfig(
    'providers: [claude: {}]\nsources: { github: { repos: [acme/*] } }\nqueue: [{ skill: fix-ci, then: review }]',
  )
  const plan = planNight({
    config,
    items: [githubPr(1)],
    allowances: { claude: allowance(config.budget, null, 0) },
    skills: { builtin: builtinSkills },
  })
  const report = await runNight({
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
    skillDirs: { user: join(root, 'none'), builtin: builtinSkillsDir },
  })
  expect(report.results.map((u) => [u.planned.unit.id, u.status, u.reason])).toEqual([
    ['acme-api-1', 'prepared', undefined],
    ['acme-api-1-review', 'skipped', 'a dry run delivers nothing for it to follow'],
  ])
})

it('stops a unit still running at night.end and publishes what it left', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nightshift-end-'))
  const origin = join(root, 'origin')
  await execa('git', ['init', '-q', '-b', 'main', origin])
  await git(origin, 'commit', '-q', '--allow-empty', '-m', 'init')
  const forge = {
    ...fakeForge(),
    clone: async (_repo: string, _branch: string, dir: string) => {
      await execa('git', ['clone', '-q', origin, dir])
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
  vi.useFakeTimers({ toFake: ['Date'] })
  const until = new Date(Date.now() + 100)
  const endless: Provider = {
    ...fakeProvider('claude'),
    async *run(job, signal) {
      await writeFile(join(job.dir, 'fix.txt'), 'half')
      await git(job.dir, 'add', 'fix.txt')
      await git(job.dir, 'commit', '-qm', 'Start the fix')
      await writeFile(join(job.dir, '.nightshift/out/pr.md'), 'Start the fix\n\nUnfinished.')
      vi.setSystemTime(until)
      if (!signal.aborted) await new Promise((ok) => signal.addEventListener('abort', ok))
      yield { type: 'done', ok: false, turns: 1 }
    },
  }
  try {
    const report = await runNight({
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
      skillDirs: { user: join(root, 'none'), builtin: builtinSkillsDir },
    })
    expect(report.results.map((u) => [u.status, u.outcome ?? u.reason])).toEqual([
      [
        'stopped: night ended',
        { kind: 'pr', url: 'https://example.com/acme/api/pull/night/acme-api-1', commits: 1 },
      ],
      ['skipped', 'the night window ended'],
    ])
  } finally {
    vi.useRealTimers()
  }
})

it('runs a chain on what the unit before delivered, and skips it after nothing', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nightshift-chain-'))
  const origin = join(root, 'origin')
  await execa('git', ['init', '-q', '-b', 'main', origin])
  await git(origin, 'commit', '-q', '--allow-empty', '-m', 'init')
  const base = fakeForge()
  const forge = {
    ...base,
    clone: async (_repo: string, branch: string, dir: string) => {
      await execa('git', ['clone', '-q', ...(branch ? ['--branch', branch] : []), origin, dir])
    },
    push: async (dir: string, branch: string, opts: { repo: string }) => {
      await git(dir, 'push', '-q', 'origin', `HEAD:refs/heads/${branch}`)
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
  const plan = planNight({
    config,
    items: [issue(5), issue(6)],
    allowances: { claude: allowance(config.budget, null, 0) },
    skills: { builtin: builtinSkills },
  })
  const seen: { prompt: string; files: string[]; diff?: string }[] = []
  const chained: Provider = {
    ...fakeProvider('claude'),
    async *run(job) {
      const previous = join(job.dir, '.nightshift/context/previous')
      seen.push({
        prompt: job.prompt,
        files: await readdir(job.dir),
        diff: await readFile(join(previous, 'diff.patch'), 'utf8').catch(() => undefined),
      })
      const out = join(job.dir, '.nightshift/out')
      if (job.unit.deliver === 'report') await writeFile(join(out, 'report.md'), 'Approve.')
      else if (job.unit.id === 'acme-api-5') {
        await writeFile(join(job.dir, 'fix.txt'), 'fixed')
        await git(job.dir, 'add', 'fix.txt')
        await git(job.dir, 'commit', '-qm', 'Add rate limits')
        await writeFile(join(out, 'pr.md'), 'Add rate limits\n\nRan the tests.')
      }
      yield { type: 'done', ok: true, turns: 2 }
    },
  }

  const report = await runNight({
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
    skillDirs: { user: join(root, 'none'), builtin: builtinSkillsDir },
  })

  expect(report.results.map((u) => [u.planned.unit.id, u.status, u.outcome ?? u.reason])).toEqual([
    [
      'acme-api-5',
      'done',
      { kind: 'pr', url: 'https://example.com/acme/api/pull/night/acme-api-5', commits: 1 },
    ],
    ['acme-api-5-review', 'done', { kind: 'report', text: 'Approve.' }],
    ['acme-api-6', 'done', { kind: 'none', reason: 'no commits' }],
    ['acme-api-6-review', 'skipped', 'acme-api-6 delivered nothing to follow'],
  ])
  const review = seen[1]
  expect(review?.files).toContain('fix.txt')
  expect(review?.diff).toMatch(/^\+\+\+ b\/fix\.txt$/m)
  expect(review?.prompt).toContain(
    'This unit follows `implement` on the same items, which opened https://example.com/acme/api/pull/night/acme-api-5 tonight',
  )
})

it('runs setup before the worker with only its own secrets, none on a foreign PR, not at all on an untrusted one, and skips a unit whose setup fails', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nightshift-setup-'))
  const forge = {
    ...fakeForge(),
    clone: async (_repo: string, branch: string, dir: string) => {
      await execa('git', ['init', '-q', dir])
      await git(dir, 'commit', '-q', '--allow-empty', '-m', 'init')
      if (branch === 'feature-2') await writeFile(join(dir, 'broken'), '')
    },
  }
  const config = parseConfig(`
providers: [claude: {}]
sources: { github: { repos: [acme/*] } }
queue: [{ skill: review }]
repos:
  acme/api:
    setup: 'if [ -f broken ]; then echo resolving; echo 404 from registry; exit 3; fi; echo "$NPM_TOKEN,$FAKE_AGENT_TOKEN" > setup.txt'
    secrets: [NPM_TOKEN]
`)
  const plan = planNight({
    config,
    items: [
      githubPr(1),
      githubPr(2),
      githubPr(3, { mine: false }),
      githubPr(4, { mine: false, trusted: false }),
    ],
    allowances: { claude: allowance(config.budget, null, 0) },
    skills: { builtin: builtinSkills },
  })
  const setups: string[] = []
  const workerEnvs: NodeJS.ProcessEnv[] = []
  const report = await runNight({
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
          workerEnvs.push(job.env)
          await writeFile(join(job.dir, '.nightshift/out/report.md'), 'Approve.')
          yield { type: 'done', ok: true, turns: 1 }
        },
      },
    },
    sources: { github: fakeSource() as Source },
    forge,
    ctx: {
      env: { PATH: process.env.PATH, FAKE_AGENT_TOKEN: 'own', NPM_TOKEN: 'npm' },
      log: () => {},
    },
    watch: () => ({ stop: async () => {} }),
    skillDirs: { user: join(root, 'none'), builtin: builtinSkillsDir },
  })

  expect(setups).toEqual(['npm,\n', ',\n', 'not run'])
  expect(workerEnvs[0]).not.toHaveProperty('NPM_TOKEN')
  expect(report.results.map((u) => [u.status, u.reason])).toEqual([
    ['done', undefined],
    ['skipped', expect.stringMatching(/^setup failed: .*code 3.*\nresolving\n404 from registry$/s)],
    ['done', undefined],
    ['done', undefined],
  ])
  const prompt = await readFile(join(root, 'run/units/acme-api-1/prompt.md'), 'utf8')
  expect(prompt).toContain('Setup, already run: `if [ -f broken ]')
  const untrusted = await readFile(join(root, 'run/units/acme-api-4/prompt.md'), 'utf8')
  expect(untrusted).toContain("Setup, not run because this PR's author isn't trusted")
})
