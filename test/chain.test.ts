import { mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execa } from 'execa'
import { expect, it } from 'vitest'
import { formatPlan } from '../src/cli/format.js'
import { parseConfig } from '../src/config/load.js'
import { bin, builtinSkillsDir } from '../src/config/paths.js'
import { recordAttempts } from '../src/core/attempts.js'
import { allowance } from '../src/core/budget.js'
import { planRun } from '../src/core/foreman.js'
import { builtinSkills } from '../src/core/skills.js'
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
      if (head.stdout !== from) throw new Error(`${branch} moved`)
      await git(dir, 'push', '-q', origin, `HEAD:refs/heads/${branch}`)
      pushedOnto.push(branch)
    },
    draftPr: async (repo: string, head: string, base: string, bodyFile: string) => {
      opened.push({ head, base, body: await readFile(bodyFile, 'utf8') })
      return `https://example.com/${repo}/pull/${head}`
    },
  }
  return { origin, opened, pushedOnto, forge }
}

/** Reports with `verdicts[id]`, or commits `<id>.txt` and keeps the PR body; `fail` stops a unit at max turns, `idle` makes nothing. */
function worker(
  verdicts: Record<string, string> = {},
  opts: { fail?: string[]; idle?: string[]; seen?: Record<string, string[]> } = {},
): Provider {
  return {
    ...fakeProvider('claude'),
    async *run(job) {
      const out = join(job.dir, '.away/out')
      if (opts.seen)
        opts.seen[job.unit.id] = (
          await readdir(join(job.dir, '.away/context/previous')).catch(() => [])
        ).sort()
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

async function run(yaml: string, items: Item[], provider: Provider) {
  const root = await mkdtemp(join(tmpdir(), 'awaywork-chain-'))
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
    dryRun: false,
    providers: { claude: provider },
    sources: { github: fakeSource() as Source },
    forge: env.forge,
    ctx: { env: {}, log: () => {} },
    watch: () => ({ stop: async () => {} }),
    skillDirs: { user: join(root, 'none'), builtin: builtinSkillsDir },
  })
  const rows = report.results.map((r) => [r.planned.unit.id, r.status, r.outcome ?? r.reason])
  return { ...env, plan, report, rows }
}

it('runs a chain with a loop in one clone and opens one draft PR with every step in it', async () => {
  const seen: Record<string, string[]> = {}
  const verdicts = { 'acme-api-1-review-1': 'changes', 'acme-api-1-review-2': 'approve' }
  const { rows, opened, origin, report, plan } = await run(
    `queue:
  - skill: implement
    then:
      - { loop: [review, address-review], until: { verdict: approve }, max: 3 }
      - plan
`,
    [issue(1)],
    worker(verdicts, { seen }),
  )
  const url = 'https://example.com/acme/api/pull/away/acme-api-1'
  expect(rows).toEqual([
    ['acme-api-1', 'done', { kind: 'pr', url, commits: 2 }],
    ['acme-api-1-review-1', 'done', { kind: 'none', reason: 'a report for the chain' }],
    ['acme-api-1-address-review-1', 'done', { kind: 'none', reason: '1 commits for the chain' }],
    ['acme-api-1-review-2', 'done', { kind: 'none', reason: 'a report for the chain' }],
    ['acme-api-1-plan', 'done', { kind: 'none', reason: 'a report for the chain' }],
  ])
  expect(report.results[0]?.loop).toBe(
    '2 rounds of review ⇄ address-review; until held: verdict approve',
  )
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
        'Loop: 2 rounds of review ⇄ address-review; until held: verdict approve; last verdict approve.',
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
      ].join('\n'),
    },
  ])
  const files = await git(origin, 'ls-tree', '--name-only', 'away/acme-api-1')
  expect(files.stdout.split('\n')).toEqual(['acme-api-1-address-review-1.txt', 'acme-api-1.txt'])
  expect(seen['acme-api-1-review-1']).toEqual(['diff.patch', 'pr.md'])
  expect(seen['acme-api-1-address-review-1']).toEqual(['pr.md', 'report.md', 'verdict'])
  expect(formatPlan(plan)).toContain("in acme-api-1's clone")
  const attempts = recordAttempts({}, report)
  expect(attempts['github:acme/api#1']).toEqual({
    runId: 'r1',
    skill: 'implement',
    updated: '2026-10-01T00:00:00Z',
  })
})

it('takes chain shapes the per-step model refused: a loop after a loop, and a gated step before one', async () => {
  const { rows, opened } = await run(
    `queue:
  - skill: implement
    then:
      - { skill: fix-ci, when: { verdict: changes } }
      - { loop: [review], until: { verdict: approve }, max: 2 }
      - { loop: [address-review], until: { command: 'true' }, max: 1 }
`,
    [issue(1)],
    worker({ 'acme-api-1-review-1': 'approve' }),
  )
  expect(rows.map(([id, status]) => [id, status])).toEqual([
    ['acme-api-1', 'done'],
    ['acme-api-1-fix-ci', 'skipped'],
    ['acme-api-1-review-1', 'done'],
    ['acme-api-1-address-review-1', 'done'],
  ])
  expect(opened.map((pr) => pr.head)).toEqual(['away/acme-api-1'])
})

it('reports on a PR someone else opened, and leaves out the steps that would commit', async () => {
  const { rows, plan, opened } = await run(
    `queue:
  - { skill: review, where: { review_requested: true }, then: [plan, implement] }
`,
    [githubPr(1, { mine: false, review_requested: true })],
    worker({ 'acme-api-1': 'comments' }),
  )
  expect(plan.units.map((p) => [p.unit.id, p.capped])).toEqual([
    ['acme-api-1', undefined],
    ['acme-api-1-plan', "then implement: deliver draft_pr: feature-1 is someone else's PR"],
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
    ['acme-api-1-plan', 'done', { kind: 'none', reason: 'a report for the chain' }],
  ])
  expect(opened).toEqual([])
})

it('pushes the whole chain onto your PR once, with the reports in its summary', async () => {
  const { rows, pushedOnto, opened } = await run(
    `queue:
  - { skill: address-review, deliver: push, where: { type: pr }, then: [review] }
`,
    [githubPr(1)],
    worker({ 'acme-api-1-review': 'approve' }),
  )
  expect(rows[0]?.[2]).toMatchObject({ kind: 'pushed', branch: 'feature-1', commits: 1 })
  expect((rows[0]?.[2] as { text: string }).text).toContain('acme-api-1-review says approve.')
  expect(pushedOnto).toEqual(['feature-1'])
  expect(opened).toEqual([])
})

it('ends the chain at a step that fails, publishes what it has, and counts a failure', async () => {
  const { rows, opened, report } = await run(
    `queue:
  - { skill: implement, then: [fix-ci, review] }
`,
    [issue(1)],
    worker({}, { fail: ['acme-api-1-fix-ci'] }),
  )
  expect(rows).toEqual([
    [
      'acme-api-1',
      'done',
      { kind: 'pr', url: 'https://example.com/acme/api/pull/away/acme-api-1', commits: 2 },
    ],
    ['acme-api-1-fix-ci', 'failed', { kind: 'none', reason: '1 commits for the chain' }],
    ['acme-api-1-review', 'skipped', 'acme-api-1-fix-ci failed'],
  ])
  expect(opened).toHaveLength(1)
  expect(recordAttempts({}, report)['github:acme/api#1']?.failed).toBe(1)
})

it('passes over the steps after one that made nothing, and counts the chain finished', async () => {
  const { rows, opened, report } = await run(
    `queue:
  - { skill: implement, then: [fix-ci, review] }
`,
    [issue(1)],
    worker({}, { idle: ['acme-api-1-fix-ci'] }),
  )
  expect(rows.map(([id, status, out]) => [id, status, out])).toEqual([
    [
      'acme-api-1',
      'done',
      { kind: 'pr', url: 'https://example.com/acme/api/pull/away/acme-api-1', commits: 1 },
    ],
    ['acme-api-1-fix-ci', 'done', { kind: 'none', reason: 'made nothing' }],
    ['acme-api-1-review', 'skipped', 'acme-api-1-fix-ci made nothing to follow'],
  ])
  expect(opened).toHaveLength(1)
  expect(recordAttempts({}, report)['github:acme/api#1']?.failed).toBeUndefined()
})
