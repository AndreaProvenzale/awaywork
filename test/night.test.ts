import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execa } from 'execa'
import { expect, it, vi } from 'vitest'
import { formatReportForTerminal } from '../src/cli/format.js'
import { parseConfig } from '../src/config/load.js'
import { builtinSkillsDir } from '../src/config/paths.js'
import { recordAttempts } from '../src/core/attempts.js'
import { allowance } from '../src/core/budget.js'
import { planNight } from '../src/core/foreman.js'
import { formatReport, runLine, summarize } from '../src/core/report.js'
import { builtinSkills } from '../src/core/skills.js'
import type { Forge, Item, Provider, Quota, Source } from '../src/core/types.js'
import { type NightInput, runNight } from '../src/worker/night.js'
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
    '| 3 | acme-api-2 | review | claude | done, 5 turns | report below, verdict approve |',
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

it("stops a unit at its provider's unit_minutes", async () => {
  const root = await mkdtemp(join(tmpdir(), 'nightshift-time-'))
  const forge = {
    ...fakeForge(),
    clone: async (_repo: string, _branch: string, dir: string) => {
      await execa('git', ['init', '-q', dir])
      await git(dir, 'commit', '-q', '--allow-empty', '-m', 'init')
    },
  }
  const config = parseConfig(
    'providers: [claude: { budget: { unit_minutes: 5 } }]\nsources: { github: { repos: [acme/*] } }\nqueue: [{ skill: fix-ci }]',
  )
  const plan = planNight({
    config,
    items: [githubPr(1)],
    allowances: { claude: allowance(config.budget, null, 0) },
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
    const report = await runNight({
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
  await execa('git', ['init', '-q', '-b', 'main', origin])
  await git(origin, 'commit', '-q', '--allow-empty', '-m', 'init')
  const opened: { head: string; base: string; body: string }[] = []
  const fake = fakeForge()
  const forge = {
    ...fake,
    clone: async (_repo: string, branch: string, dir: string) => {
      await execa('git', ['clone', '-q', ...(branch ? ['--branch', branch] : []), origin, dir])
    },
    push: async (dir: string, branch: string, opts: { repo: string }) => {
      await fake.push(dir, branch, opts)
      await git(dir, 'push', '-q', origin, `HEAD:refs/heads/${branch}`)
    },
    draftPr: async (repo: string, head: string, base: string, bodyFile: string) => {
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
    const out = join(job.dir, '.nightshift/out')
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

const issue = (n: number) =>
  fakeItem({
    source: 'github',
    id: String(n),
    key: `acme/api#${n}`,
    type: 'issue',
    fields: { repo: 'acme/api' },
  })

it("stacks a repo's draft PRs off the default branch on the last one published tonight", async () => {
  const root = await mkdtemp(join(tmpdir(), 'nightshift-stack-'))
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
        await writeFile(join(job.dir, '.nightshift/out/pr.md'), `Implement ${job.unit.id}\n\nDone.`)
      }
      yield { type: 'done', ok: true, turns: 1 }
    },
  }
  const config = parseConfig(
    'providers: [claude: {}]\nsources: { github: { repos: [acme/*] } }\nqueue: [{ skill: implement }]',
  )
  const plan = planNight({
    config,
    items: [issue(1), issue(2), githubPr(4), issue(3)],
    allowances: { claude: allowance(config.budget, null, 0) },
    skills: { builtin: builtinSkills },
  })
  const report = await runNight({
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
    skillDirs: { user: join(root, 'none'), builtin: builtinSkillsDir },
  })

  const first = 'https://example.com/acme/api/pull/night/acme-api-1'
  expect(report.results.map((u) => u.outcome)).toContainEqual({
    kind: 'pr',
    url: 'https://example.com/acme/api/pull/night/acme-api-3',
    commits: 1,
  })
  expect(opened.map((pr) => [pr.head, pr.base])).toEqual([
    ['night/acme-api-1', ''],
    ['night/acme-api-4', 'feature-4'],
    ['night/acme-api-3', 'night/acme-api-1'],
  ])
  expect(opened[0]?.body).not.toContain('Stacked on')
  expect(opened[2]?.body).toBe(
    `Implement acme-api-3\n\nDone.\n\nStacked on ${first}: merge that first.\n`,
  )
  expect(prompts[0]).toContain('cut from the default branch.')
  const stacked = `cut from \`night/acme-api-1\`.\n\n\`night/acme-api-1\` is tonight's earlier draft PR ${first}`
  expect([prompts[1], prompts[3]]).toEqual([
    expect.stringContaining(stacked),
    expect.stringContaining(stacked),
  ])
  const files = await git(origin, 'ls-tree', '--name-only', 'night/acme-api-3')
  expect(files.stdout.split('\n')).toEqual(['acme-api-1.txt', 'acme-api-3.txt'])
})

it("stacks a chain's draft PRs on each other, and the repo's next unit on the chain's last", async () => {
  const root = await mkdtemp(join(tmpdir(), 'nightshift-stack-chain-'))
  const { opened, forge } = await originForge(root)
  const config = parseConfig(`
providers: [claude: {}]
sources: { github: { repos: [acme/*] } }
queue: [{ skill: implement, then: { skill: review, deliver: draft_pr } }]
`)
  const plan = planNight({
    config,
    items: [issue(1), issue(2)],
    allowances: { claude: allowance(config.budget, null, 0) },
    skills: { builtin: builtinSkills },
  })
  await runNight({
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
    skillDirs: { user: join(root, 'none'), builtin: builtinSkillsDir },
  })

  const url = (branch: string) => `https://example.com/acme/api/pull/${branch}`
  expect(opened.map((pr) => [pr.head, pr.base])).toEqual([
    ['night/acme-api-1', ''],
    ['night/acme-api-1-review', 'night/acme-api-1'],
    ['night/acme-api-2', 'night/acme-api-1-review'],
    ['night/acme-api-2-review', 'night/acme-api-2'],
  ])
  expect(opened[1]?.body).toContain(`Stacked on ${url('night/acme-api-1')}: merge that first.`)
  expect(opened[2]?.body).toContain(
    `Stacked on ${url('night/acme-api-1-review')}: merge that first.`,
  )
})

it("keeps a chain on your own PR off the stack, and stacks the repo's next units as if it weren't there", async () => {
  const root = await mkdtemp(join(tmpdir(), 'nightshift-stack-past-'))
  const { origin, opened, forge } = await originForge(root)
  await git(origin, 'branch', 'feature-4')
  const config = parseConfig(`
providers: [claude: {}]
sources: { github: { repos: [acme/*] } }
queue:
  - { skill: implement, where: { type: pr }, then: { skill: review, deliver: draft_pr } }
  - { skill: implement }
`)
  const plan = planNight({
    config,
    items: [issue(1), githubPr(4), issue(3)],
    allowances: { claude: allowance(config.budget, null, 0) },
    skills: { builtin: builtinSkills },
  })
  await runNight({
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
    skillDirs: { user: join(root, 'none'), builtin: builtinSkillsDir },
  })

  expect(opened.map((pr) => [pr.head, pr.base])).toEqual([
    ['night/acme-api-4', 'feature-4'],
    ['night/acme-api-4-review', 'night/acme-api-4'],
    ['night/acme-api-1', ''],
    ['night/acme-api-3', 'night/acme-api-1'],
  ])
  const files = await git(origin, 'ls-tree', '--name-only', 'night/acme-api-3')
  expect(files.stdout.split('\n')).toEqual(['acme-api-1.txt', 'acme-api-3.txt'])
})

it("runs setup without the repo's secrets on a branch a worker wrote tonight", async () => {
  const root = await mkdtemp(join(tmpdir(), 'nightshift-stack-setup-'))
  const { forge } = await originForge(root)
  const config = parseConfig(`
providers: [claude: {}]
sources: { github: { repos: [acme/*] } }
queue: [{ skill: implement, then: review }]
repos:
  acme/api:
    setup: 'echo "$NPM_TOKEN" > .nightshift/setup.txt'
    secrets: [NPM_TOKEN]
`)
  const plan = planNight({
    config,
    items: [issue(1), issue(2)],
    allowances: { claude: allowance(config.budget, null, 0) },
    skills: { builtin: builtinSkills },
  })
  const report = await runNight({
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
    skillDirs: { user: join(root, 'none'), builtin: builtinSkillsDir },
  })

  const ids = report.results.map((u) => u.planned.unit.id)
  expect(ids).toEqual(['acme-api-1', 'acme-api-1-review', 'acme-api-2', 'acme-api-2-review'])
  const setups = await Promise.all(
    ids.map((id) => readFile(join(root, 'run/units', id, 'setup.txt'), 'utf8')),
  )
  expect(setups).toEqual(['npm\n', '\n', '\n', '\n'])
})

/** Commits and keeps a PR body current; reviews and QA write a report and a verdict from `verdicts`. */
function looper(verdicts: Record<string, string>, seen: Record<string, string[]> = {}): Provider {
  return {
    ...fakeProvider('claude'),
    async *run(job) {
      const previous = join(job.dir, '.nightshift/context/previous')
      seen[job.unit.id] = (await readdir(previous).catch(() => [])).sort()
      const out = join(job.dir, '.nightshift/out')
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

it("loops review and fix in the draft PR unit's clone until the verdict holds, and publishes once", async () => {
  const root = await mkdtemp(join(tmpdir(), 'nightshift-loop-'))
  const { origin, opened, forge } = await originForge(root)
  const config = parseConfig(`
providers: [claude: {}]
sources: { github: { repos: [acme/*] } }
queue:
  - skill: implement
    then:
      - { loop: [review, address-review], until: { verdict: approve }, max: 3 }
      - { skill: qa-feedback, deliver: report }
`)
  const now = 1790391600 * 1000 - 3 * 24 * 60 * 60 * 1000
  const plan = planNight({
    config,
    items: [issue(1)],
    allowances: { claude: allowance(config.budget, quota(0.36), now) },
    skills: { builtin: builtinSkills },
  })
  const seen: Record<string, string[]> = {}
  const verdicts = { 'acme-api-1-review-1': 'changes', 'acme-api-1-review-2': 'approve' }
  const prompts: string[] = []
  const provider = looper(verdicts, seen)
  const report = await runNight({
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
    ctx: { env: {}, log: () => {} },
    watch: () => ({ stop: async () => {} }),
    skillDirs: { user: join(root, 'none'), builtin: builtinSkillsDir },
  })

  const url = 'https://example.com/acme/api/pull/night/acme-api-1'
  expect(report.results.map((u) => [u.planned.unit.id, u.outcome, u.verdict])).toEqual([
    ['acme-api-1', { kind: 'pr', url, commits: 2 }, undefined],
    [
      'acme-api-1-review-1',
      { kind: 'report', text: 'acme-api-1-review-1 says changes.' },
      'changes',
    ],
    [
      'acme-api-1-address-review-1',
      { kind: 'none', reason: "1 commits for the loop's PR" },
      undefined,
    ],
    [
      'acme-api-1-review-2',
      { kind: 'report', text: 'acme-api-1-review-2 says approve.' },
      'approve',
    ],
    [
      'acme-api-1-qa-feedback',
      { kind: 'report', text: 'acme-api-1-qa-feedback says nothing.' },
      undefined,
    ],
  ])
  expect(opened.map((pr) => [pr.head, pr.base])).toEqual([['night/acme-api-1', '']])
  expect(opened[0]?.body).toBe(
    [
      'Add rate limits',
      '',
      'Done.',
      '',
      '## Night-shift loop',
      '',
      '2 rounds of review ⇄ address-review; until held: verdict approve.',
      '',
      '<details><summary>Last report: acme-api-1-review-2</summary>',
      '',
      'acme-api-1-review-2 says approve.',
      '',
      '</details>',
      '',
    ].join('\n'),
  )
  const files = await git(origin, 'ls-tree', '--name-only', 'night/acme-api-1')
  expect(files.stdout.split('\n')).toEqual(['acme-api-1-address-review-1.txt', 'acme-api-1.txt'])
  expect(seen).toEqual({
    'acme-api-1': [],
    'acme-api-1-review-1': ['diff.patch', 'pr.md'],
    'acme-api-1-address-review-1': ['pr.md', 'report.md', 'verdict'],
    'acme-api-1-review-2': ['diff.patch', 'pr.md'],
    'acme-api-1-qa-feedback': ['diff.patch', 'pr.md'],
  })
  expect(prompts[2]).toContain(
    'This unit is round 1 of at most 3 of a loop (`review` ⇄ `address-review`) that ends once verdict approve.',
  )
  expect(prompts[4]).toContain(`which opened ${url} tonight; you start from its branch.`)
  const text = formatReport(report)
  expect(text).toContain(
    `| 1 | acme-api-1 | implement | claude | done, 1 turns (loop: 2 rounds of review ⇄ address-review; until held: verdict approve) | ${url} (2 commits) |`,
  )
  expect(text).toContain(
    '| 4 | acme-api-1-review-2 | review | claude | done, 1 turns | report below, verdict approve |',
  )
})

it('ends a loop when no provider is left for a round, and publishes what it has', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nightshift-loop-budget-'))
  const { opened, forge } = await originForge(root)
  const config = parseConfig(`
providers: [claude: {}]
sources: { github: { repos: [acme/*] } }
budget: { fallback: { units: 3, turns: 10 } }
queue:
  - skill: implement
    then: { loop: [review, address-review], until: { verdict: approve }, max: 3 }
`)
  const plan = planNight({
    config,
    items: [issue(1)],
    allowances: { claude: allowance(config.budget, null, 0) },
    skills: { builtin: builtinSkills },
  })
  const report = await runNight({
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
    skillDirs: { user: join(root, 'none'), builtin: builtinSkillsDir },
  })

  const noProvider = 'no provider left: claude used its 3 fallback units'
  expect(report.results.map((u) => [u.planned.unit.id, u.status, u.loop ?? u.reason])).toEqual([
    ['acme-api-1', 'done', `1 round of review ⇄ address-review; ${noProvider}`],
    ['acme-api-1-review-1', 'done', undefined],
    ['acme-api-1-address-review-1', 'done', undefined],
    ['acme-api-1-review-2', 'skipped', noProvider],
  ])
  expect(opened.map((pr) => pr.head)).toEqual(['night/acme-api-1'])
})

it('loops on a fresh clone after a report up to max, and keeps a report when the loop committed nothing', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nightshift-loop-report-'))
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
    then: { loop: { skill: qa-feedback, deliver: report }, until: { verdict: approve }, max: 1 }
`)
  const now = 1790391600 * 1000 - 3 * 24 * 60 * 60 * 1000
  const plan = planNight({
    config,
    items: [issue(1), githubPr(4)],
    allowances: { claude: allowance(config.budget, quota(0.36), now) },
    skills: { builtin: builtinSkills },
  })
  const verdicts = {
    'acme-api-1-review-1': 'changes',
    'acme-api-1-review-2': 'changes',
    'acme-api-4-qa-feedback-1': 'approve',
  }
  const report = await runNight({
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
    skillDirs: { user: join(root, 'none'), builtin: builtinSkillsDir },
  })

  expect(report.results.map((u) => [u.planned.unit.id, u.outcome?.kind, u.loop])).toEqual([
    ['acme-api-1', 'report', undefined],
    ['acme-api-1-implement-1', 'pr', '2 rounds of implement ⇄ review; max 2 rounds reached'],
    ['acme-api-1-review-1', 'report', undefined],
    ['acme-api-1-implement-2', 'none', undefined],
    ['acme-api-1-review-2', 'report', undefined],
    ['acme-api-4', 'report', undefined],
    ['acme-api-4-qa-feedback-1', 'report', '1 round of qa-feedback; until held: verdict approve'],
  ])
  expect(opened.map((pr) => [pr.head, pr.base])).toEqual([['night/acme-api-1', '']])
  const files = await git(origin, 'ls-tree', '--name-only', 'night/acme-api-1')
  expect(files.stdout.split('\n')).toEqual([
    'acme-api-1-implement-1.txt',
    'acme-api-1-implement-2.txt',
  ])
})

/** Plans `yaml` for `items` and runs the night against a local origin. */
async function loopNight(
  yaml: string,
  items: Item[],
  provider: Provider,
  {
    forge: overrides,
    ...input
  }: Omit<Partial<NightInput>, 'forge'> & { forge?: Partial<Forge> } = {},
) {
  const root = await mkdtemp(join(tmpdir(), 'nightshift-loop-'))
  const { origin, opened, forge } = await originForge(root)
  const config = parseConfig(`providers: [claude: {}]
sources: { github: { repos: [acme/*] } }
${yaml}`)
  const now = 1790391600 * 1000 - 3 * 24 * 60 * 60 * 1000
  const plan = planNight({
    config,
    items,
    allowances: { claude: allowance(config.budget, quota(0.36), now) },
    skills: { builtin: builtinSkills },
  })
  const report = await runNight({
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
    skillDirs: { user: join(root, 'none'), builtin: builtinSkillsDir },
    ...input,
  })
  return { report, opened, origin }
}

it('records a loop interrupted after a report as unpublished, so its chain retries without counting a failure', async () => {
  const stop = new AbortController()
  const provider = looper({})
  const item = fakeItem({
    source: 'github',
    id: '1',
    key: 'acme/api#1',
    type: 'issue',
    fields: { repo: 'acme/api', updated: '2026-09-01T00:00:00Z' },
  })
  const { report, opened } = await loopNight(
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

  expect(report.results.map((u) => [u.planned.unit.id, u.status, u.outcome?.kind])).toEqual([
    ['acme-api-1', 'done', 'report'],
    ['acme-api-1-implement-1', 'done', 'none'],
    ['acme-api-1-review-1', 'stopped: aborted', 'report'],
  ])
  expect(report.results[1]?.outcome).toEqual({
    kind: 'none',
    reason: 'interrupted',
    unpublished: true,
  })
  expect(opened).toEqual([])
  expect(recordAttempts({}, report)).toEqual({})
})

it("records an interrupted loop as unpublished even when it kept its host's report", async () => {
  const stop = new AbortController()
  const provider = looper({ 'acme-api-1-qa-feedback-1': 'changes' })
  const item = fakeItem({
    ...issue(1),
    fields: { repo: 'acme/api', updated: '2026-09-01T00:00:00Z' },
  })
  const { report } = await loopNight(
    `queue:
  - skill: plan
    then: { loop: [{ skill: qa-feedback, deliver: report }, fix-ci], until: { verdict: approve }, max: 2 }
`,
    [item],
    {
      ...provider,
      async *run(job, signal) {
        if (job.unit.id === 'acme-api-1-fix-ci-1') stop.abort()
        else yield* provider.run(job, signal)
      },
    },
    { signal: stop.signal },
  )

  expect(report.results[1]?.outcome).toEqual({
    kind: 'none',
    reason: 'interrupted',
    unpublished: true,
  })
  expect(recordAttempts({}, report)).toEqual({})
})

it("counts a failed loop as a failure even when it kept its host's report", async () => {
  const provider = looper({ 'acme-api-1-qa-feedback-1': 'changes' })
  const item = fakeItem({
    ...issue(1),
    fields: { repo: 'acme/api', updated: '2026-09-01T00:00:00Z' },
  })
  const { report } = await loopNight(
    `queue:
  - skill: plan
    then: { loop: [{ skill: qa-feedback, deliver: report }, fix-ci], until: { verdict: approve }, max: 2 }
`,
    [item],
    {
      ...provider,
      async *run(job, signal) {
        if (job.unit.id === 'acme-api-1-fix-ci-1') yield { type: 'done', ok: false, turns: 1 }
        else yield* provider.run(job, signal)
      },
    },
  )

  expect(report.results[1]?.outcome).toMatchObject({ kind: 'none', unpublished: true })
  expect(Object.values(recordAttempts({}, report))).toEqual([
    expect.objectContaining({ skill: 'plan', failed: 1 }),
  ])
})

it("retries a loop that kept its host's report and reached night.end without counting a failure", async () => {
  const provider = looper({ 'acme-api-1-qa-feedback-1': 'changes' })
  const until = new Date(Date.now() + 60 * 60 * 1000)
  const item = fakeItem({
    ...issue(1),
    fields: { repo: 'acme/api', updated: '2026-09-01T00:00:00Z' },
  })
  const { report } = await loopNight(
    `queue:
  - skill: plan
    then: { loop: [{ skill: qa-feedback, deliver: report }, fix-ci], until: { verdict: approve }, max: 2 }
`,
    [item],
    {
      ...provider,
      async *run(job, signal) {
        yield* provider.run(job, signal)
        if (job.unit.id === 'acme-api-1-qa-feedback-1') until.setTime(0)
      },
    },
    { until },
  )

  expect(report.results[1]?.outcome).toMatchObject({ kind: 'none', unpublished: true })
  expect(report.results[2]).toMatchObject({ status: 'skipped', reason: 'the night window ended' })
  expect(recordAttempts({}, report)).toEqual({})
})

it('skips the step after a loop whose publish threw, though its host kept a report', async () => {
  const { report } = await loopNight(
    `queue:
  - skill: plan
    then:
      - { loop: [{ skill: qa-feedback, deliver: report }, fix-ci], until: { verdict: approve }, max: 1 }
      - review
`,
    [issue(1)],
    looper({ 'acme-api-1-qa-feedback-1': 'changes' }),
    { forge: { push: async () => Promise.reject(new Error('push refused')) } },
  )

  expect(report.results.map((u) => [u.planned.unit.id, u.status, u.reason])).toEqual([
    ['acme-api-1', 'done', undefined],
    ['acme-api-1-qa-feedback-1', 'error', 'push refused'],
    ['acme-api-1-fix-ci-1', 'done', undefined],
    ['acme-api-1-review', 'skipped', 'acme-api-1-qa-feedback-1 delivered nothing to follow'],
  ])
})

it('counts a failure when a loop that reached night.end fails to publish', async () => {
  const provider = looper({})
  const until = new Date(Date.now() + 60 * 60 * 1000)
  const item = fakeItem({
    ...issue(1),
    fields: { repo: 'acme/api', updated: '2026-09-01T00:00:00Z' },
  })
  const { report } = await loopNight(
    `queue:
  - skill: implement
    then: { loop: [review, address-review], until: { verdict: approve }, max: 2 }
`,
    [item],
    {
      ...provider,
      async *run(job, signal) {
        yield* provider.run(job, signal)
        until.setTime(0)
      },
    },
    { until, forge: { push: async () => Promise.reject(new Error('push refused')) } },
  )

  expect(report.results.map((u) => [u.planned.unit.id, u.status, u.reason])).toEqual([
    ['acme-api-1', 'error', 'push refused'],
    ['acme-api-1-review-1', 'skipped', 'the night window ended'],
  ])
  expect(recordAttempts({}, report)['github:acme/api#1']).toMatchObject({ failed: 1 })
})

it('counts a failure for a loop host whose publish was refused, though a round reached night.end', async () => {
  const provider = looper({})
  const until = new Date(Date.now() + 60 * 60 * 1000)
  const item = fakeItem({
    ...issue(1),
    fields: { repo: 'acme/api', updated: '2026-09-01T00:00:00Z' },
  })
  const { report } = await loopNight(
    `queue:
  - skill: implement
    then: { loop: [review], until: { verdict: approve }, max: 1 }
`,
    [item],
    {
      ...provider,
      async *run(job, signal) {
        yield* provider.run(job, signal)
        await rm(join(job.dir, '.nightshift/out/pr.md'), { force: true })
        until.setTime(0)
      },
    },
    { until },
  )

  expect(report.results[0]?.outcome).toMatchObject({ kind: 'none', unpublished: true })
  expect(report.results[1]).toMatchObject({ status: 'skipped', reason: 'the night window ended' })
  expect(recordAttempts({}, report)['github:acme/api#1']).toMatchObject({ failed: 1 })
})

it("runs the step after a loop that kept its host's report on the host's base", async () => {
  const { report, opened } = await loopNight(
    `queue:
  - skill: plan
    then:
      - { loop: [{ skill: qa-feedback, deliver: report }, fix-ci], until: { verdict: approve }, max: 2 }
      - review
`,
    [issue(1)],
    looper({ 'acme-api-1-qa-feedback-1': 'approve' }),
  )

  expect(report.results.map((u) => [u.planned.unit.id, u.status, u.outcome?.kind])).toEqual([
    ['acme-api-1', 'done', 'report'],
    ['acme-api-1-qa-feedback-1', 'done', 'report'],
    ['acme-api-1-review', 'done', 'report'],
  ])
  expect(opened).toEqual([])
})

it('runs the whole loop for a step after it that --unit names', async () => {
  const { report } = await loopNight(
    `queue:
  - skill: implement
    then:
      - { loop: [review, address-review], until: { verdict: approve }, max: 2 }
      - { skill: qa-feedback, deliver: report }
`,
    [issue(1), issue(2)],
    looper({ 'acme-api-1-review-1': 'approve' }),
    { only: 'acme-api-1-qa-feedback' },
  )

  expect(report.results.map((u) => [u.planned.unit.id, u.status])).toEqual([
    ['acme-api-1', 'done'],
    ['acme-api-1-review-1', 'done'],
    ['acme-api-1-qa-feedback', 'done'],
  ])
})

it("names why a loop didn't start after a host that failed", async () => {
  const provider = looper({})
  const { report } = await loopNight(
    `queue:
  - skill: implement
    then: { loop: [review, address-review], until: { verdict: approve }, max: 2 }
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
    ['acme-api-1-review-1', 'skipped', 'acme-api-1 error, loop not started'],
  ])
})

it("runs the steps after a loop that kept its host's report where that report ran", async () => {
  const kept = { 'acme-api-1-qa-feedback-1': 'approve' }
  const draft = await loopNight(
    `queue:
  - skill: plan
    then:
      - { loop: [{ skill: qa-feedback, deliver: report }, fix-ci], until: { verdict: approve }, max: 2 }
      - review
      - implement
`,
    [issue(1)],
    looper(kept),
  )
  expect(draft.report.results.map((u) => [u.planned.unit.id, u.status, u.outcome?.kind])).toEqual([
    ['acme-api-1', 'done', 'report'],
    ['acme-api-1-qa-feedback-1', 'done', 'report'],
    ['acme-api-1-review', 'done', 'report'],
    ['acme-api-1-implement', 'done', 'pr'],
  ])
  expect(draft.opened.map((pr) => pr.base)).toEqual([''])

  const loop = await loopNight(
    `queue:
  - skill: plan
    then:
      - { loop: [{ skill: qa-feedback, deliver: report }, fix-ci], until: { verdict: approve }, max: 2 }
      - review
      - { loop: [implement, { skill: address-review, deliver: report }], until: { verdict: approve }, max: 2 }
`,
    [issue(1)],
    looper({ ...kept, 'acme-api-1-address-review-1': 'approve' }),
  )
  expect(loop.report.results.map((u) => [u.planned.unit.id, u.status, u.outcome?.kind])).toEqual([
    ['acme-api-1', 'done', 'report'],
    ['acme-api-1-qa-feedback-1', 'done', 'report'],
    ['acme-api-1-review', 'done', 'report'],
    ['acme-api-1-implement-1', 'done', 'pr'],
    ['acme-api-1-address-review-1', 'done', 'report'],
  ])
  expect(loop.opened.map((pr) => pr.base)).toEqual([''])
})

it('waits for a verdict written in the loop before `until: { verdict: { not } }` holds', async () => {
  const { report } = await loopNight(
    `queue:
  - skill: implement
    then: { loop: [address-review, review], until: { verdict: { not: changes } }, max: 2 }
`,
    [issue(1)],
    looper({ 'acme-api-1-review-1': 'approve' }),
  )

  expect(report.results.map((u) => [u.planned.unit.id, u.status, u.loop])).toEqual([
    ['acme-api-1', 'done', '1 round of address-review ⇄ review; until held: verdict not changes'],
    ['acme-api-1-address-review-1', 'done', undefined],
    ['acme-api-1-review-1', 'done', undefined],
  ])
})

it('ends a loop whose hand-off failed, and still finishes the night', async () => {
  const provider = looper({})
  const { report, opened } = await loopNight(
    `queue:
  - skill: implement
    then: { loop: [review, address-review], until: { verdict: approve }, max: 2 }
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
    ['acme-api-1-review-1', 'done'],
  ])
  expect(report.results[0]?.loop).toMatch(
    /^1 round of review ⇄ address-review; acme-api-1-review-1 error: /,
  )
  expect(opened).toEqual([])
})

it("hands a round off without running the clone's diff command or writing through its symlinks", async () => {
  const stop = new AbortController()
  const root = await mkdtemp(join(tmpdir(), 'nightshift-outside-'))
  const marker = join(root, 'ran')
  const outside = join(root, 'outside')
  await writeFile(outside, 'mine\n')
  const provider = looper({ 'acme-api-1-review-1': 'changes' })
  await loopNight(
    `queue:
  - skill: implement
    then: { loop: [review, address-review], until: { verdict: approve }, max: 2 }
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
        if (job.unit.id === 'acme-api-1-address-review-1')
          await symlink(outside, join(job.dir, '.nightshift/out/diff.patch'))
      },
    },
    {
      runDir: join(root, 'run'),
      signal: stop.signal,
      ctx: {
        env: {},
        log: (line) => {
          if (line === 'acme-api-1-address-review-1: done') stop.abort()
        },
      },
    },
  )

  expect(existsSync(marker)).toBe(false)
  expect(await readFile(outside, 'utf8')).toBe('mine\n')
  const patch = join(root, 'run/units/acme-api-1-address-review-1/out/diff.patch')
  expect(await readFile(patch, 'utf8')).toContain('+++ b/acme-api-1-address-review-1.txt')
})

it('refuses to publish a loop whose PR body a round turned into a symlink', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nightshift-outside-'))
  const outside = join(root, 'outside')
  await writeFile(outside, 'mine\n')
  const provider = looper({ 'acme-api-1-review-1': 'changes' })
  const { report, opened } = await loopNight(
    `queue:
  - skill: implement
    then: { loop: [review, address-review], until: { verdict: approve }, max: 1 }
`,
    [issue(1)],
    {
      ...provider,
      async *run(job, signal) {
        yield* provider.run(job, signal)
        if (job.unit.id === 'acme-api-1-address-review-1') {
          const body = join(job.dir, '.nightshift/out/pr.md')
          await rm(body)
          await symlink(outside, body)
        }
      },
    },
  )

  expect(report.results[0]?.status).toBe('error')
  expect(report.results[0]?.reason).toBe('.nightshift/out/pr.md in the clone is a symlink')
  expect(opened).toEqual([])
  expect(await readFile(outside, 'utf8')).toBe('mine\n')
})

it("ends a loop whose clone a round symlinked, before the next round's workspace touches it", async () => {
  const root = await mkdtemp(join(tmpdir(), 'nightshift-outside-'))
  await mkdir(join(root, 'previous'))
  await writeFile(join(root, 'previous', 'keep'), 'mine\n')
  const provider = looper({ 'acme-api-1-review-1': 'changes' })
  const { report } = await loopNight(
    `queue:
  - skill: implement
    then: { loop: [review, address-review], until: { verdict: approve }, max: 2 }
`,
    [issue(1)],
    {
      ...provider,
      async *run(job, signal) {
        yield* provider.run(job, signal)
        if (job.unit.id === 'acme-api-1-review-1') {
          await rm(join(job.dir, '.nightshift/context'), { recursive: true })
          await symlink(root, join(job.dir, '.nightshift/context'))
        }
      },
    },
  )

  expect(report.results.map((u) => [u.planned.unit.id, u.status, u.reason])).toEqual([
    ['acme-api-1', 'done', undefined],
    ['acme-api-1-review-1', 'done', undefined],
    ['acme-api-1-address-review-1', 'error', '.nightshift/context in the clone is a symlink'],
  ])
  expect(await readFile(join(root, 'previous', 'keep'), 'utf8')).toBe('mine\n')
})

it('reads past FIFOs a round left as its verdict or report, and finishes the night', async () => {
  const provider = looper({ 'acme-api-1-review-1': 'changes' })
  const { report, opened } = await loopNight(
    `queue:
  - skill: implement
    then: { loop: [review, address-review], until: { verdict: approve }, max: 1 }
`,
    [issue(1)],
    {
      ...provider,
      async *run(job, signal) {
        yield* provider.run(job, signal)
        if (job.unit.id === 'acme-api-1-review-1')
          for (const name of ['verdict', 'report.md']) {
            const file = join(job.dir, '.nightshift/out', name)
            await rm(file, { force: true })
            await execa('mkfifo', [file])
          }
      },
    },
  )

  const round = report.results.find((u) => u.planned.unit.id === 'acme-api-1-review-1')
  expect(round?.verdict).toBeUndefined()
  expect(round?.outcome).toEqual({ kind: 'none', reason: 'no report written' })
  expect(report.results[0]?.loop).toBe('1 round of review ⇄ address-review; max 1 round reached')
  expect(opened).toHaveLength(1)
}, 60_000)

it('ends a loop interrupted between rounds, and retries its chain without counting a failure', async () => {
  const stop = new AbortController()
  const { report, opened } = await loopNight(
    `queue:
  - skill: implement
    then: { loop: [review, address-review], until: { verdict: approve }, max: 2 }
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
    ['acme-api-1-address-review-1', 'skipped', 'interrupted'],
  ])
  expect(report.results[0]?.loop).toBe('1 round of review ⇄ address-review; interrupted')
  expect(report.results[0]?.outcome).toEqual({
    kind: 'none',
    reason: 'interrupted',
    unpublished: true,
  })
  expect(opened).toEqual([])
  expect(recordAttempts({}, report)).toEqual({})
})
