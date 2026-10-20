import { existsSync } from 'node:fs'
import {
  copyFile,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  symlink,
  utimes,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { execa } from 'execa'
import { expect, it } from 'vitest'
import { formatPlan } from '../src/cli/format.js'
import { parseConfig } from '../src/config/load.js'
import { bin, builtinSkillsDir } from '../src/config/paths.js'
import { type Attempts, recordAttempts } from '../src/core/attempts.js'
import { allowance } from '../src/core/budget.js'
import { footer } from '../src/core/footer.js'
import { planRun } from '../src/core/foreman.js'
import { isolate } from '../src/core/launch.js'
import { formatReport, type RunReport, runLine, summarize } from '../src/core/report.js'
import { builtinSkills } from '../src/core/skills.js'
import { unitStats } from '../src/core/stats.js'
import type { Item, Provider, Source } from '../src/core/types.js'
import { runUnits } from '../src/worker/units.js'
import { fakeForge } from './fakes/forge.js'
import { fakeItem, githubPr } from './fakes/items.js'
import { fakeProvider } from './fakes/provider.js'
import { fakeSource } from './fakes/source.js'

process.env.GIT_COMMITTER_NAME ??= 't'
process.env.GIT_COMMITTER_EMAIL ??= 't@t'

const git = (dir: string, ...args: string[]) =>
  execa(bin('git'), ['-C', dir, '-c', 'user.name=t', '-c', 'user.email=t@t', ...args])

const reset = new Date(2026, 8, 26, 3).getTime() / 1000
const quota = {
  windows: [
    { name: 'five_hour', span: 'short' as const, used: 0.1, resetsAt: 1790254200 },
    { name: 'seven_day', span: 'long' as const, used: 0.36, resetsAt: reset },
  ],
}
const week = reset * 1000 - 3 * 24 * 60 * 60 * 1000

/** What a slice publishes from a clone whose `.git` the restore refused. */
const refused = { kind: 'none', reason: "the clone's .git was refused", unpublished: true }

const issue = (n: number, fields: Item['fields'] = {}) =>
  fakeItem({
    source: 'github',
    id: String(n),
    key: `acme/api#${n}`,
    type: 'issue',
    fields: { repo: 'acme/api', updated: '2026-10-01T00:00:00Z', ...fields },
  })

async function originForge(root: string) {
  const origin = join(root, 'origin')
  await execa(bin('git'), ['init', '-q', '-b', 'main', origin])
  await git(origin, 'commit', '-q', '--allow-empty', '-m', 'init')
  await git(origin, 'branch', 'feature-1')
  const opened: { head: string; base: string; body: string }[] = []
  const pushedOnto: string[] = []
  const fake = fakeForge()
  // The PRs on each branch as the forge lists them, with the footer it adds.
  const footers: Record<string, string> = {}
  const forge = {
    ...fake,
    prsOn: async (repo: string, branch: string) =>
      footers[branch]
        ? [
            {
              url: `https://example.com/${repo}/pull/${branch}`,
              body: footers[branch],
              merged: false,
            },
          ]
        : [],
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
      pushedOnto.push(branch)
    },
    draftPr: async (
      repo: string,
      head: string,
      base: string,
      bodyFile: string,
      runId: string,
      items: Pick<Item, 'source' | 'key'>[],
    ) => {
      opened.push({ head, base, body: await readFile(bodyFile, 'utf8') })
      footers[head] = footer(runId, items)
      return `https://example.com/${repo}/pull/${head}`
    },
  }
  return { origin, opened, pushedOnto, forge }
}

/**
 * Reports with `verdicts[id]`, or commits `<id>.txt` and keeps the PR body; `fail` stops a unit at max
 * turns, `idle` makes nothing, `abort` presses Ctrl-C in it; `seen`, `prompts` and `bodies` keep each
 * step's `previous/` listing, prompt and `previous/pr.md`.
 */
function worker(
  verdicts: Record<string, string> = {},
  opts: {
    fail?: string[]
    idle?: string[]
    abort?: { id: string; controller: AbortController }
    seen?: Record<string, string[]>
    prompts?: Record<string, string>
    bodies?: Record<string, string>
  } = {},
): Provider {
  return {
    ...fakeProvider('claude'),
    async *run(job) {
      const out = join(job.dir, '.away/out')
      const previous = join(job.dir, '.away/context/previous')
      if (opts.seen) opts.seen[job.unit.id] = (await readdir(previous).catch(() => [])).sort()
      if (opts.prompts) opts.prompts[job.unit.id] = job.prompt
      if (opts.bodies)
        opts.bodies[job.unit.id] = await readFile(join(previous, 'pr.md'), 'utf8').catch(() => '')
      if (opts.abort?.id === job.unit.id) {
        opts.abort.controller.abort()
        yield { type: 'done', ok: false, turns: 1 }
        return
      }
      if (opts.idle?.includes(job.unit.id)) {
        yield { type: 'done', ok: true, turns: 1 }
        return
      }
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
      if (opts.fail?.includes(job.unit.id)) {
        yield { type: 'done', ok: false, turns: 60, error: 'max turns' }
        return
      }
      yield { type: 'done', ok: true, turns: 1 }
    },
  }
}

async function run(
  yaml: string,
  items: Item[],
  provider: Provider,
  opts: {
    signal?: AbortSignal
    dryRun?: boolean
    attempts?: Attempts
    /** Files earlier runs left, by path in the runs dir. */
    earlier?: Record<string, string>
  } = {},
) {
  const root = await mkdtemp(join(tmpdir(), 'awaywork-chain-'))
  for (const [file, text] of Object.entries(opts.earlier ?? {})) {
    await mkdir(dirname(join(root, file)), { recursive: true })
    await writeFile(join(root, file), text)
  }
  const env = await originForge(root)
  const config = parseConfig(
    `providers: [claude: {}]\nsources: { github: { repos: [acme/*] } }\n${yaml}`,
  )
  const plan = planRun({
    config,
    items,
    allowances: { claude: allowance(config.budget, quota, week, config.windows) },
    skills: { builtin: builtinSkills },
  })
  const report = await runUnits({
    config,
    configDir: root,
    plan,
    runId: 'r1',
    runDir: join(root, 'run'),
    dryRun: !!opts.dryRun,
    signal: opts.signal,
    attempts: opts.attempts,
    providers: { claude: provider },
    sources: { github: fakeSource() as Source },
    forge: env.forge,
    ctx: { env: {}, log: () => {} },
    watch: () => ({ stop: async () => {} }),
    skillDirs: { user: join(root, 'none'), builtin: builtinSkillsDir },
  })
  const rows = report.results.map((r) => [
    r.planned.unit.id,
    r.status,
    r.outcome ?? r.made ?? r.reason,
  ])
  return { ...env, plan, report, rows }
}

it('runs a chain with a loop in one clone and opens one draft PR with every step in it', async () => {
  const seen: Record<string, string[]> = {}
  const verdicts = { 'acme-api-1-review-1': 'changes', 'acme-api-1-review-2': 'approve' }
  const { rows, opened, origin, report, plan } = await run(
    `queue:
  - skill: implement
    then:
      - { loop: [review, fix], until: { verdict: approve }, max: 3 }
      - plan
`,
    [issue(1)],
    worker(verdicts, { seen }),
  )
  const url = 'https://example.com/acme/api/pull/away/acme-api-1'
  expect(rows).toEqual([
    ['acme-api-1', 'done', { kind: 'pr', url, commits: 2, head: expect.any(String) }],
    ['acme-api-1-review-1', 'done', 'a report'],
    ['acme-api-1-fix-1', 'done', '1 commit'],
    ['acme-api-1-review-2', 'done', 'a report'],
    ['acme-api-1-plan', 'done', 'a report'],
  ])
  expect(report.results[0]?.loop).toBe('2 rounds of review ⇄ fix; until held: verdict approve')
  expect(opened).toEqual([
    {
      head: 'away/acme-api-1',
      base: '',
      body: [
        'Add rate limits',
        '',
        'Done.',
        '',
        '## Awaywork chain',
        '',
        'Loop: 2 rounds of review ⇄ fix; until held: verdict approve; last verdict approve.',
        '',
        '<details><summary>Report: acme-api-1-review-2</summary>',
        '',
        'acme-api-1-review-2 says approve.',
        '',
        '</details>',
        '',
        '<details><summary>Report: acme-api-1-plan</summary>',
        '',
        'acme-api-1-plan says nothing.',
        '',
        '</details>',
        '',
        '',
        'Closes acme/api#1',
        '',
      ].join('\n'),
    },
  ])
  const files = await git(origin, 'ls-tree', '--name-only', 'away/acme-api-1')
  expect(files.stdout.split('\n')).toEqual(['acme-api-1-fix-1.txt', 'acme-api-1.txt'])
  expect(seen['acme-api-1-review-1']).toEqual(['diff.patch', 'pr.md'])
  expect(seen['acme-api-1-fix-1']).toEqual(['pr.md', 'report.md', 'verdict'])
  expect(formatPlan(plan)).toContain(
    [
      '     then loop review ⇄ fix until verdict approve, at most 3 rounds',
      '       review (built-in) on claude',
      '       fix (built-in) on claude',
      '     then plan (built-in) on claude',
    ].join('\n'),
  )
  const attempts = recordAttempts({}, report)
  expect(attempts['github:acme/api#1']).toEqual({
    runId: 'r1',
    skill: 'implement',
    updated: '2026-10-01T00:00:00Z',
    report: { runId: 'r1', unit: 'acme-api-1', step: '5-plan', skill: 'plan' },
  })
})

it('takes chain shapes the per-step model refused: a loop after a loop, and a gated step before one', async () => {
  const { rows, opened } = await run(
    `queue:
  - skill: implement
    then:
      - { skill: fix, when: { verdict: changes } }
      - { loop: [review], until: { verdict: approve }, max: 2 }
      - { loop: [fix], until: { command: 'true' }, max: 1 }
`,
    [issue(1)],
    worker({ 'acme-api-1-review-1': 'approve' }),
  )
  expect(rows.map(([id, status]) => [id, status])).toEqual([
    ['acme-api-1', 'done'],
    ['acme-api-1-fix', 'skipped'],
    ['acme-api-1-review-1', 'done'],
    ['acme-api-1-fix-1', 'done'],
  ])
  expect(opened.map((pr) => pr.head)).toEqual(['away/acme-api-1'])
})

it('reports on a PR someone else opened, and refuses a chain there that could commit', async () => {
  const { rows, plan, opened } = await run(
    `queue:
  - { skill: review, where: { title: { matches: 'PR 1' } }, then: [plan] }
  - { skill: review, where: { type: pr }, then: [implement] }
`,
    [githubPr(1, { mine: false }), githubPr(2, { mine: false })],
    worker({ 'acme-api-1': 'comments' }),
  )
  expect(plan.skipped.map((s) => [s.item.key, s.reason])).toEqual([
    ['acme/api#2', "deliver draft_pr: feature-2 is someone else's PR, and implement commits"],
  ])
  expect(rows).toEqual([
    [
      'acme-api-1',
      'done',
      {
        kind: 'report',
        text: '### acme-api-1\n\nacme-api-1 says comments.\n\n### acme-api-1-plan\n\nacme-api-1-plan says nothing.',
      },
    ],
    ['acme-api-1-plan', 'done', 'a report'],
  ])
  expect(opened).toEqual([])
})

it('pushes the whole chain onto your PR once, with the reports in its summary', async () => {
  const { rows, report, pushedOnto, opened } = await run(
    `queue:
  - { skill: fix, deliver: push, where: { type: pr }, then: [review] }
`,
    [githubPr(1)],
    worker({ 'acme-api-1-review': 'approve' }),
  )
  expect(rows[0]?.[2]).toMatchObject({ kind: 'pushed', branch: 'feature-1', commits: 1 })
  expect(report.results[0]?.outcome).toMatchObject({
    text: expect.stringContaining('acme-api-1-review says approve.'),
  })
  expect(pushedOnto).toEqual(['feature-1'])
  expect(opened).toEqual([])
})

it('ends the chain at a step that fails, publishes what it has, and counts a failure', async () => {
  const { rows, opened, report } = await run(
    `queue:
  - { skill: implement, then: [fix, review] }
`,
    [issue(1)],
    worker({}, { fail: ['acme-api-1-fix'] }),
  )
  expect(rows).toEqual([
    [
      'acme-api-1',
      'done',
      {
        kind: 'pr',
        url: 'https://example.com/acme/api/pull/away/acme-api-1',
        commits: 2,
        head: expect.any(String),
      },
    ],
    ['acme-api-1-fix', 'failed', '1 commit'],
    ['acme-api-1-review', 'skipped', 'acme-api-1-fix failed'],
  ])
  expect(opened).toHaveLength(1)
  expect(recordAttempts({}, report)['github:acme/api#1']?.failed).toBe(1)
})

it('passes over the steps after one that made nothing, and counts the chain finished', async () => {
  const { rows, opened, report } = await run(
    `queue:
  - { skill: implement, then: [fix, review] }
`,
    [issue(1)],
    worker({}, { idle: ['acme-api-1-fix'] }),
  )
  expect(rows.map(([id, status, out]) => [id, status, out])).toEqual([
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
    ['acme-api-1-fix', 'done', 'nothing'],
    ['acme-api-1-review', 'skipped', 'acme-api-1-fix committed nothing'],
  ])
  expect(opened).toHaveLength(1)
  expect(recordAttempts({}, report)['github:acme/api#1']?.failed).toBeUndefined()
})

it('ends the chain after a report step that wrote no report, and reports nothing', async () => {
  const { rows, opened } = await run(
    `queue:
  - { skill: plan, then: [implement, review] }
`,
    [issue(1)],
    worker({}, { idle: ['acme-api-1'] }),
  )
  expect(rows).toEqual([
    ['acme-api-1', 'done', { kind: 'none', reason: 'no commits' }],
    ['acme-api-1-implement', 'skipped', 'acme-api-1 wrote no report'],
    ['acme-api-1-review', 'skipped', 'acme-api-1 wrote no report'],
  ])
  expect(opened).toEqual([])
})

const pull = (branch: string) => `https://example.com/acme/api/pull/${branch}`
const pr = (branch: string, commits: number) => ({
  kind: 'pr',
  url: pull(branch),
  commits,
  head: expect.any(String),
})

it('opens a draft PR per slice: a stacked one on -2, on the slice before as pushed', async () => {
  const seen: Record<string, string[]> = {}
  const prompts: Record<string, string> = {}
  const bodies: Record<string, string> = {}
  const hooked = join(await mkdtemp(join(tmpdir(), 'awaywork-hook-')), 'log')
  const { rows, opened, origin, report, plan, forge } = await run(
    `notify: { command: 'echo "$AWAYWORK_UNIT $AWAYWORK_PR_URL" >> ${hooked}' }
queue:
  - skill: implement
    then: [review, { skill: fix, stack: true }]
`,
    [issue(1)],
    worker({}, { seen, prompts, bodies }),
  )
  // The forge lists slice 1's PR with a footer naming the item: slice 2 takes -2 rather than skip as tried.
  expect(rows).toEqual([
    ['acme-api-1', 'done', pr('away/acme-api-1', 1)],
    ['acme-api-1-review', 'done', 'a report'],
    ['acme-api-1-fix', 'done', pr('away/acme-api-1-2', 1)],
  ])
  const published = [
    'Add rate limits',
    '',
    'Done.',
    '',
    '## Awaywork chain',
    '',
    '<details><summary>Report: acme-api-1-review</summary>',
    '',
    'acme-api-1-review says nothing.',
    '',
    '</details>',
    '',
  ].join('\n')
  expect(opened).toEqual([
    { head: 'away/acme-api-1', base: '', body: published },
    {
      head: 'away/acme-api-1-2',
      base: 'away/acme-api-1',
      body: `Add rate limits\n\nDone.\n\nCloses acme/api#1\n\nStacked on ${pull('away/acme-api-1')}: merge that first.\n`,
    },
  ])
  expect(forge.stacked).toEqual([[pull('away/acme-api-1'), pull('away/acme-api-1-2')]])
  const parent = await git(origin, 'rev-parse', 'away/acme-api-1-2^')
  expect(parent.stdout).toBe((await git(origin, 'rev-parse', 'away/acme-api-1')).stdout)
  const format = '--format=%s|%(trailers:key=Awaywork,valueonly,separator=)'
  expect((await git(origin, 'log', format, 'away/acme-api-1-2')).stdout.split('\n')).toEqual([
    'Work on acme-api-1-fix|r1',
    'Work on acme-api-1|r1',
    'init|',
  ])
  const files = await git(origin, 'ls-tree', '--name-only', 'away/acme-api-1-2')
  expect(files.stdout.split('\n')).toEqual(['acme-api-1-fix.txt', 'acme-api-1.txt'])

  expect(seen['acme-api-1-fix']).toEqual(['pr.md', 'report.md'])
  expect(bodies['acme-api-1-fix']).toBe(published)
  expect(prompts['acme-api-1-fix']).toContain(
    [
      'Unit `acme-api-1-fix`, skill `fix`. You are on the new branch `away/acme-api-1-2`, cut from `away/acme-api-1`.',
      '',
      'This unit is a step of a chain (implement → review → stack fix) whose steps all work in this clone. Each slice, from the first step or a `stack` one on, publishes once when it ends, as a draft PR stacked on the slice before; this step is in slice 2 of 2, and the branch may already hold its commits.',
      '',
      `\`away/acme-api-1\` is the earlier awaywork PR ${pull('away/acme-api-1')}: your PR stacks on it, so leave its commits as they are.`,
    ].join('\n'),
  )
  expect(prompts['acme-api-1-fix']).toContain(
    `the body of the slice before's draft PR ${pull('away/acme-api-1')} as published in \`pr.md\``,
  )
  expect(prompts['acme-api-1-fix']).toContain('Commit on this branch and write `.away/out/pr.md`')

  expect(formatPlan(plan)).toContain(
    '     then review (built-in) on claude\n     stack fix (built-in) on claude',
  )
  const text = formatReport(report)
  expect(text).toContain(
    [
      `| 1 | acme-api-1 | implement → review → stack fix | claude | done, 3 turns | ${pull('away/acme-api-1')} (1 commits); ${pull('away/acme-api-1-2')} (1 commits) |`,
      `|  | └ slice 1 | implement → review | claude | done, 2 turns | ${pull('away/acme-api-1')} (1 commits) |`,
      '|  |   └ acme-api-1 | implement | claude | done, 1 turns | 1 commit |',
      '|  |   └ acme-api-1-review | review | claude | done, 1 turns | a report |',
      `|  | └ slice 2 | fix | claude | done, 1 turns | ${pull('away/acme-api-1-2')} (1 commits) |`,
      '|  |   └ acme-api-1-fix | fix | claude | done, 1 turns | 1 commit |',
    ].join('\n'),
  )
  expect(runLine('r1', text)).toBe('r1  1 units, 2 draft PRs, 0 reports')
  expect(summarize(report, 'report.md').split('\n')[0]).toBe(
    'Run r1: 2 draft PRs, 0 reports, 1 units',
  )
  expect((await readFile(hooked, 'utf8')).split('\n')).toEqual([
    `acme-api-1 ${pull('away/acme-api-1')}`,
    `acme-api-1-review ${pull('away/acme-api-1')}`,
    `acme-api-1-fix ${pull('away/acme-api-1-2')}`,
    '',
  ])
  expect(unitStats(report.results).map((s) => [s.id, s.pr])).toEqual([
    ['acme-api-1', true],
    ['acme-api-1-review', false],
    ['acme-api-1-fix', true],
  ])
  expect(recordAttempts({}, report)['github:acme/api#1']?.failed).toBeUndefined()
})

it('prepares a stacked slice on its own branch in a dry run', async () => {
  const { report } = await run(
    'queue: [{ skill: implement, then: [{ skill: fix, stack: true }] }]\n',
    [issue(1)],
    worker(),
    { dryRun: true },
  )
  expect(report.results.map((r) => [r.planned.unit.id, r.status, r.planned.unit.branch])).toEqual([
    ['acme-api-1', 'prepared', 'away/acme-api-1'],
    ['acme-api-1-fix', 'prepared', 'away/acme-api-1-2'],
  ])
})

it('publishes a stacked slice on the branch its own type names', async () => {
  const { rows, opened } = await run(
    "branch: '{type}/{key}'\nqueue: [{ skill: implement, then: [{ skill: fix, stack: true }] }]\n",
    [issue(1)],
    worker(),
  )
  expect(rows).toEqual([
    ['acme-api-1', 'done', pr('feat/acme-api-1', 1)],
    ['acme-api-1-fix', 'done', pr('fix/acme-api-1', 1)],
  ])
  expect(opened.map((o) => [o.head, o.base])).toEqual([
    ['feat/acme-api-1', ''],
    ['fix/acme-api-1', 'feat/acme-api-1'],
  ])
})

it('cuts slice 2 in the clone with nothing over its base, through no symlink a worker planted in .git', async () => {
  const outside = await mkdtemp(join(tmpdir(), 'awaywork-victim-'))
  const planted = { FETCH_HEAD: join(outside, 'fetch'), 'logs/HEAD': join(outside, 'reflog') }
  for (const victim of Object.values(planted)) await writeFile(victim, 'untouched\n')
  const over: string[] = []
  const base = worker()
  const provider: Provider = {
    ...base,
    async *run(job, signal) {
      if (job.unit.id === 'acme-api-1-fix')
        over.push((await git(job.dir, 'log', '--oneline', 'away/acme-api-1..HEAD')).stdout)
      const events = []
      for await (const event of base.run(job, signal)) events.push(event)
      if (job.unit.id === 'acme-api-1')
        for (const [path, victim] of Object.entries(planted)) {
          await rm(join(job.dir, '.git', path), { force: true })
          await symlink(victim, join(job.dir, '.git', path))
        }
      yield* events
    },
  }
  const { rows } = await run(
    'queue: [{ skill: implement, then: [{ skill: fix, stack: true }] }]\n',
    [issue(1)],
    provider,
  )
  expect(rows).toEqual([
    ['acme-api-1', 'done', pr('away/acme-api-1', 1)],
    ['acme-api-1-fix', 'done', pr('away/acme-api-1-2', 1)],
  ])
  for (const victim of Object.values(planted))
    expect(await readFile(victim, 'utf8')).toBe('untouched\n')
  expect(over).toEqual([''])
})

it('ends the chain on a .git/index a worker symlinked, writing nothing through it', async () => {
  const victim = join(await mkdtemp(join(tmpdir(), 'awaywork-victim-')), 'index')
  let planted: Buffer | undefined
  const base = worker()
  const provider: Provider = {
    ...base,
    async *run(job, signal) {
      const events = []
      for await (const event of base.run(job, signal)) events.push(event)
      if (job.unit.id === 'acme-api-1') {
        const index = join(job.dir, '.git', 'index')
        await copyFile(index, victim)
        planted = await readFile(victim)
        await rm(index)
        await symlink(victim, index)
        // Stat-dirty, so a git that refreshes the index writes it.
        const later = new Date(Date.now() + 60_000)
        await utimes(join(job.dir, 'acme-api-1.txt'), later, later)
      }
      yield* events
    },
  }
  // `verify` runs `git status` in the clone after the failed step, as a `when` or `until` check does.
  const { rows } = await run(
    "repos: { acme/api: { verify: 'true' } }\nqueue: [{ skill: implement, then: [{ skill: fix, stack: true }] }]\n",
    [issue(1)],
    provider,
  )
  expect(await readFile(victim)).toEqual(planted)
  expect(rows).toEqual([
    ['acme-api-1', 'error', refused],
    ['acme-api-1-fix', 'skipped', 'acme-api-1 error: .git/index in the clone is a symlink'],
  ])
})

it("runs no check in a clone whose .git it couldn't restore, so a planted filter never runs", async () => {
  const marker = join(await mkdtemp(join(tmpdir(), 'awaywork-marker-')), 'marker')
  const base = worker()
  const provider: Provider = {
    ...base,
    async *run(job, signal) {
      const events = []
      for await (const event of base.run(job, signal)) events.push(event)
      if (job.unit.id === 'acme-api-1') {
        await writeFile(join(job.dir, '.git', 'objects', 'info', 'alternates'), '')
        await writeFile(join(job.dir, '.gitattributes'), '* filter=evil\n')
        const clean = `sh -c 'echo "$ZZ_SECRET" >> ${marker}; cat'`
        await git(job.dir, 'config', 'filter.evil.clean', clean)
        // Stat-dirty, so `git status` cleans it through the filter.
        const later = new Date(Date.now() + 60_000)
        await utimes(join(job.dir, 'acme-api-1.txt'), later, later)
      }
      yield* events
    },
  }
  process.env.ZZ_SECRET = 'hunter2'
  try {
    const { rows } = await run(
      "repos: { acme/api: { verify: 'true' } }\nqueue: [{ skill: implement, then: [{ skill: fix, stack: true }] }]\n",
      [issue(1)],
      provider,
    )
    expect(await readFile(marker, 'utf8').catch(() => 'no marker')).toBe('no marker')
    expect(rows).toEqual([
      ['acme-api-1', 'error', refused],
      [
        'acme-api-1-fix',
        'skipped',
        'acme-api-1 error: .git/objects/info/alternates in the clone points elsewhere',
      ],
    ])
  } finally {
    delete process.env.ZZ_SECRET
  }
})

it.each([
  ['links .git to a repo of its own', 'link'],
  ['plants an empty alternates', 'alternates'],
])('publishes nothing and runs no git in a refused clone whose worker %s', async (_, how) => {
  const marker = join(await mkdtemp(join(tmpdir(), 'awaywork-marker-')), 'marker')
  const base = worker()
  const provider: Provider = {
    ...base,
    async *run(job, signal) {
      const events = []
      for await (const event of base.run(job, signal)) events.push(event)
      // A partial clone whose promisor "fetch" is the worker's command, run by any git missing an object.
      const repo = how === 'link' ? await mkdtemp(join(tmpdir(), 'awaywork-planted-')) : job.dir
      const cmd = join(dirname(job.dir), 'cmd')
      await writeFile(cmd, `#!/bin/sh\necho "ran $ZZ_SECRET" >> ${marker}\nexit 1\n`, {
        mode: 0o755,
      })
      if (how === 'link') {
        await git(repo, 'init', '-q')
        await git(repo, 'commit', '-q', '--allow-empty', '-m', 'planted')
      } else await writeFile(join(repo, '.git', 'objects', 'info', 'alternates'), '')
      for (const [key, value] of [
        ['core.repositoryformatversion', '1'],
        ['extensions.partialClone', 'origin'],
        ['remote.origin.promisor', 'true'],
        ['remote.origin.uploadpack', cmd],
      ])
        await git(repo, 'config', key as string, value as string)
      if (how === 'link') {
        await rm(join(job.dir, '.git'), { recursive: true, force: true })
        await symlink(join(repo, '.git'), join(job.dir, '.git'))
      } else await writeFile(join(repo, '.git', 'HEAD'), `${'1'.repeat(40)}\n`)
      yield* events
    },
  }
  process.env.ZZ_SECRET = 'hunter2'
  try {
    const { rows, opened } = await run('queue: [{ skill: implement }]\n', [issue(1)], provider)
    expect(await readFile(marker, 'utf8').catch(() => 'no marker')).toBe('no marker')
    expect(opened).toEqual([])
    expect(rows).toEqual([['acme-api-1', 'error', refused]])
  } finally {
    delete process.env.ZZ_SECRET
  }
})

it('never lets git find a repo above the clone, where a worker can plant one', async () => {
  const marker = join(await mkdtemp(join(tmpdir(), 'awaywork-marker-')), 'marker')
  const base = worker()
  const provider: Provider = {
    ...base,
    async *run(job, signal) {
      const events = []
      for await (const event of base.run(job, signal)) events.push(event)
      if (job.unit.id === 'acme-api-1') {
        // The clone's repo moves up a level; an empty `.git` stays, so git would walk up to it.
        const planted = join(dirname(job.dir), '.git')
        await rm(planted, { recursive: true, force: true })
        await execa('mv', [join(job.dir, '.git'), planted])
        await mkdir(join(job.dir, '.git'))
        const config = (...args: string[]) =>
          execa(bin('git'), ['--git-dir', planted, 'config', ...args])
        await config('core.worktree', job.dir)
        await config('filter.evil.clean', `sh -c 'echo ran >> ${marker}; cat'`)
        await writeFile(join(job.dir, '.gitattributes'), '* filter=evil\n')
        const later = new Date(Date.now() + 60_000)
        await utimes(join(job.dir, 'acme-api-1.txt'), later, later)
      }
      yield* events
    },
  }
  const { rows } = await run(
    "repos: { acme/api: { verify: 'true' } }\nqueue: [{ skill: implement, then: [{ skill: fix, stack: true }] }]\n",
    [issue(1)],
    provider,
  )
  expect(await readFile(marker, 'utf8').catch(() => 'no marker')).toBe('no marker')
  expect(rows[0]?.slice(0, 2)).toEqual(['acme-api-1', 'error'])
  expect(rows[0]?.[2]).toContain("not a git repository: '.git'")
})

it('ends the chain on a clone it couldn’t take back from the worker user, and touches it no more', async () => {
  // A sudo that runs nothing and refuses to chown anything back from the worker.
  const fakes = await mkdtemp(join(tmpdir(), 'awaywork-sudo-'))
  const sudo = `#!/bin/sh\ncase "$*" in *chown*awaywork:*) exit 0;; *chown*) echo refused >&2; exit 1;; esac\n`
  await writeFile(join(fakes, 'sudo'), sudo, { mode: 0o755 })
  const path = process.env.PATH
  process.env.PATH = `${fakes}:${path}`
  isolate('awaywork')
  const base = worker()
  let clone = ''
  const provider: Provider = {
    ...base,
    run: (job, signal) => {
      clone = job.dir
      return base.run(job, signal)
    },
  }
  try {
    const { report, opened } = await run(
      'queue: [{ skill: implement, then: [fix] }]\n',
      [issue(1)],
      provider,
    )
    expect(report.results.map((r) => [r.status, r.reason])).toEqual([
      ['error', "couldn't chown the clone, left as it is: refused"],
      ['skipped', "acme-api-1 error: couldn't chown the clone, left as it is: refused"],
    ])
    expect(report.results[0]?.outcome?.kind).toBe('none')
    expect(opened).toEqual([])
    expect(existsSync(join(clone, 'acme-api-1.txt'))).toBe(true)
  } finally {
    isolate(undefined)
    process.env.PATH = path
    await rm(dirname(dirname(clone)), { recursive: true, force: true })
  }
})

it('starts a slice at a loop with stack, and diffs `changed` from where the chain started', async () => {
  const { rows, opened, report } = await run(
    `queue:
  - skill: implement
    then:
      - { loop: [fix, review], until: { verdict: approve }, max: 2, stack: true }
      - { skill: plan, when: { changed: acme-api-1.txt } }
`,
    [issue(1)],
    worker({ 'acme-api-1-review-1': 'approve' }),
  )
  expect(rows).toEqual([
    ['acme-api-1', 'done', pr('away/acme-api-1', 1)],
    ['acme-api-1-fix-1', 'done', pr('away/acme-api-1-2', 1)],
    ['acme-api-1-review-1', 'done', 'a report'],
    ['acme-api-1-plan', 'done', 'a report'],
  ])
  expect(report.results.map((r) => r.loop)).toEqual([
    undefined,
    '1 round of fix ⇄ review; until held: verdict approve',
    undefined,
    undefined,
  ])
  expect(opened.map((o) => [o.head, o.base])).toEqual([
    ['away/acme-api-1', ''],
    ['away/acme-api-1-2', 'away/acme-api-1'],
  ])
  expect(opened[0]?.body).toBe('Add rate limits\n\nDone.')
  expect(opened[1]?.body).toContain('Loop: 1 round of fix ⇄ review; until held: verdict approve')
  expect(opened[1]?.body).toContain('acme-api-1-plan says nothing.')
})

it('keeps the slices before when a step of a stacked slice fails, and publishes what that slice has', async () => {
  const { rows, opened, report } = await run(
    'queue: [{ skill: implement, then: [{ skill: fix, stack: true }, review] }]\n',
    [issue(1)],
    worker({}, { fail: ['acme-api-1-fix'] }),
  )
  expect(rows).toEqual([
    ['acme-api-1', 'done', pr('away/acme-api-1', 1)],
    ['acme-api-1-fix', 'failed', pr('away/acme-api-1-2', 1)],
    ['acme-api-1-review', 'skipped', 'acme-api-1-fix failed'],
  ])
  expect(opened.map((o) => o.head)).toEqual(['away/acme-api-1', 'away/acme-api-1-2'])
  expect(recordAttempts({}, report)['github:acme/api#1']?.failed).toBe(1)
})

it('ends the chain when a stacked slice starts with a step that commits nothing', async () => {
  const { rows, opened, report } = await run(
    'queue: [{ skill: implement, then: [{ skill: fix, stack: true }, review] }]\n',
    [issue(1)],
    worker({}, { idle: ['acme-api-1-fix'] }),
  )
  expect(rows).toEqual([
    ['acme-api-1', 'done', pr('away/acme-api-1', 1)],
    ['acme-api-1-fix', 'done', { kind: 'none', reason: 'no commits' }],
    ['acme-api-1-review', 'skipped', 'acme-api-1-fix committed nothing'],
  ])
  expect(opened.map((o) => o.head)).toEqual(['away/acme-api-1'])
  expect(recordAttempts({}, report)['github:acme/api#1']?.failed).toBeUndefined()
})

it('drops the open slice on Ctrl-C and keeps the ones published before', async () => {
  const controller = new AbortController()
  const { rows, opened, origin, report } = await run(
    'queue: [{ skill: implement, then: [{ skill: fix, stack: true }, review] }]\n',
    [issue(1)],
    worker({}, { abort: { id: 'acme-api-1-fix', controller } }),
    { signal: controller.signal },
  )
  expect(rows).toEqual([
    ['acme-api-1', 'done', pr('away/acme-api-1', 1)],
    [
      'acme-api-1-fix',
      'stopped: aborted',
      { kind: 'none', reason: 'interrupted', unpublished: true },
    ],
    ['acme-api-1-review', 'skipped', 'interrupted'],
  ])
  expect(opened.map((o) => o.head)).toEqual(['away/acme-api-1'])
  const branches = await git(origin, 'branch', '--format=%(refname:short)')
  expect(branches.stdout.split('\n')).toEqual(['away/acme-api-1', 'feature-1', 'main'])
  expect(recordAttempts({}, report)).toEqual({})
})

it('keeps the slices that fit under a cap, leaves out the rest and names the cap', async () => {
  const { plan, opened, report } = await run(
    `limits: { units: 3 }
queue: [{ skill: implement, then: [review, { skill: fix, stack: true }] }]
`,
    [issue(1), issue(2)],
    worker(),
  )
  expect(plan.units.map((p) => [p.unit.id, p.slice, p.capped])).toEqual([
    ['acme-api-1', undefined, undefined],
    ['acme-api-1-review', undefined, undefined],
    ['acme-api-1-fix', 1, undefined],
    ['acme-api-2', undefined, 'stack fix: over the cap: limits.units is 3'],
    ['acme-api-2-review', undefined, undefined],
  ])
  expect(formatPlan(plan)).toContain(
    '     then review (built-in) on claude\n     stack fix: over the cap: limits.units is 3',
  )
  // The repo's next chain starts from the default branch, not on this run's last PR.
  expect(opened.map((o) => [o.head, o.base])).toEqual([
    ['away/acme-api-1', ''],
    ['away/acme-api-1-2', 'away/acme-api-1'],
    ['away/acme-api-2', ''],
  ])
  // A capped chain left slices out, so none of its PRs closes the issue.
  expect(opened.map((o) => o.body.includes('Closes'))).toEqual([false, true, false])
  expect(formatReport(report)).toContain(
    '| 2 | acme-api-2 | implement → review | claude | done, 2 turns (stack fix: over the cap: limits.units is 3) |',
  )
})

it('refuses a stack on a step that reports, or after steps that all report', async () => {
  const reasons = async (rule: string) =>
    (await run(`queue: [${rule}]\n`, [issue(1)], worker())).plan.skipped.map((s) => s.reason)
  expect(await reasons('{ skill: implement, then: [{ skill: review, stack: true }] }')).toEqual([
    'stack on review: it reports, so its draft PR would have nothing in it',
  ])
  expect(
    await reasons(
      '{ skill: plan, then: [{ loop: [implement, review], until: { verdict: approve }, max: 1, stack: true }] }',
    ),
  ).toEqual(['stack on implement: every step before it reports, so there is nothing to stack on'])
})

it('stacks a chain on your own PR: slice 1 into its branch, slice 2 onto slice 1', async () => {
  const { opened, forge } = await run(
    `queue:
  - { skill: implement, where: { type: pr }, then: [{ skill: fix, stack: true }] }
  - { skill: implement, where: { type: issue } }
`,
    [githubPr(1), { ...issue(2), linkedPrs: githubPr(1).linkedPrs }],
    worker(),
  )
  // Your PR closes its issue, not the stack on it.
  expect(
    opened.map((o) => [o.head, o.base, o.body.includes('Stacked on'), o.body.includes('Closes')]),
  ).toEqual([
    ['away/acme-api-1', 'feature-1', false, false],
    ['away/acme-api-1-2', 'away/acme-api-1', true, false],
  ])
  expect(forge.stacked).toEqual([[pull('away/acme-api-1'), pull('away/acme-api-1-2')]])
})

it('hands a chain its first step the report an earlier run left, and later steps the step before', async () => {
  const seen: Record<string, string[]> = {}
  const prompts: Record<string, string> = {}
  const { rows } = await run(
    'queue:\n  - { skill: implement, then: [review] }\n',
    [issue(1)],
    worker({}, { seen, prompts }),
    {
      attempts: {
        'github:acme/api#1': {
          runId: 'r0',
          skill: 'plan',
          updated: '',
          report: { runId: 'r0', unit: 'acme-api-1', step: '2-review', skill: 'review' },
        },
      },
      earlier: {
        'r0/units/acme-api-1/1-plan/out/report.md': 'old plan',
        'r0/units/acme-api-1/2-review/out/report.md': 'old review',
        'r0/units/acme-api-1/2-review/out/verdict': 'ignored',
      },
    },
  )
  expect(rows.map(([id, status]) => [id, status])).toEqual([
    ['acme-api-1', 'done'],
    ['acme-api-1-review', 'done'],
  ])
  expect(seen['acme-api-1']).toEqual(['report.md'])
  expect(prompts['acme-api-1']).toContain('in run r0, `review` left its report')
  expect(seen['acme-api-1-review']).toEqual(['diff.patch', 'pr.md'])
})

it('hands a retried first step the report an earlier run left', async () => {
  const seen: string[][] = []
  const base = worker()
  const flaky: Provider = {
    ...base,
    async *run(job, signal) {
      seen.push((await readdir(join(job.dir, '.away/context/previous')).catch(() => [])).sort())
      if (seen.length === 1) return yield { type: 'done', ok: false, turns: 60, error: 'max turns' }
      yield* base.run(job, signal)
    },
  }
  const { rows } = await run(
    'queue:\n  - { skill: implement, model: { claude: [sonnet, opus] } }\n',
    [issue(1)],
    flaky,
    {
      attempts: {
        'github:acme/api#1': {
          runId: 'r0',
          skill: 'plan',
          updated: '',
          report: { runId: 'r0', unit: 'acme-api-1', step: '1-plan', skill: 'plan' },
        },
      },
      earlier: { 'r0/units/acme-api-1/1-plan/out/report.md': 'the plan' },
    },
  )
  expect(rows.map(([id, status]) => [id, status])).toEqual([
    ['acme-api-1', 'failed'],
    ['acme-api-1', 'done'],
  ])
  expect(seen).toEqual([['report.md'], ['report.md']])
})

it('hands a retry the plan report when the failed implement before it left none', async () => {
  const attempt = (runId: string, skill: string, result: object) => {
    const planned = { unit: { id: 'acme-api-1', skill, items: [issue(1)] } }
    const results = [{ planned, ...result }]
    return {
      runId,
      startedAt: new Date(),
      plan: { units: [planned] },
      results,
    } as unknown as RunReport
  }
  const planned = recordAttempts(
    {},
    attempt('plan-run', 'plan', { status: 'done', reported: true, step: '1-plan' }),
  )
  const attempts = recordAttempts(planned, attempt('failed-run', 'implement', { status: 'failed' }))
  expect(attempts['github:acme/api#1']).toMatchObject({
    runId: 'failed-run',
    failed: 1,
    report: { runId: 'plan-run', unit: 'acme-api-1', step: '1-plan', skill: 'plan' },
  })

  const seen: Record<string, string[]> = {}
  const prompts: Record<string, string> = {}
  await run('queue:\n  - skill: implement\n', [issue(1)], worker({}, { seen, prompts }), {
    attempts,
    earlier: {
      'plan-run/units/acme-api-1/1-plan/out/report.md': 'the plan',
      'failed-run/units/acme-api-1/1-implement/out/worker.log': 'max turns',
    },
  })
  expect(seen['acme-api-1']).toEqual(['report.md'])
  expect(prompts['acme-api-1']).toContain('in run plan-run, `plan` left its report')
})
