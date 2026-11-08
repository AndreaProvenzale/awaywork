import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { execa } from 'execa'
import { describe, expect, it } from 'vitest'
import { formatWhy } from '../src/cli/format.js'
import { parseConfig } from '../src/config/load.js'
import { bin, builtinSkillsDir } from '../src/config/paths.js'
import { pushedOnto, recordAttempts, unchangedSince } from '../src/core/attempts.js'
import { allowance } from '../src/core/budget.js'
import { planRun } from '../src/core/foreman.js'
import { formatReport } from '../src/core/report.js'
import { builtinSkills } from '../src/core/skills.js'
import type { Item, Provider, Source } from '../src/core/types.js'
import { runUnits } from '../src/worker/units.js'
import { fakeForge } from './fakes/forge.js'
import { githubPr } from './fakes/items.js'
import { fakeProvider } from './fakes/provider.js'
import { fakeSource } from './fakes/source.js'

const skills = { builtin: builtinSkills }

const git = async (dir: string, ...args: string[]) =>
  (await execa(bin('git'), ['-C', dir, '-c', 'user.name=t', '-c', 'user.email=t@t', ...args]))
    .stdout

const withRepo = (setup: string, verify: string) =>
  parseConfig(`
providers: [claude: {}]
sources: { github: { repos: [acme/*] } }
queue:
  - skill: sync
    where: { type: pr, mine: true, behind: { gt: 0 } }
    deliver: push
gates:
  anything: { changed: ["**"] }
repos:
  acme/api:
    setup: '${setup}'
    verify: '${verify}'
`)
const config = withRepo('echo ran >> .away/setup.txt', 'test -f base-2.txt')

/** A worker would spend quota: none may run. */
const noWorker: Provider = {
  ...fakeProvider('claude'),
  run: () => {
    throw new Error('a worker ran')
  },
}

/** Your PR 1 on `feature-1`, into `main`, as the source reads it. */
const pr = (fields: Item['fields'] = {}): Item => {
  const item = githubPr(1, {
    behind: 2,
    conflicts: false,
    updated: '2026-11-01T00:00:00Z',
    ...fields,
  })
  return { ...item, linkedPrs: item.linkedPrs.map((p) => ({ ...p, into: 'main' })) }
}

/** That PR, its base `main` read at `head`. */
const onBase = (head: string, fields: Item['fields'] = {}): Item => {
  const item = pr(fields)
  return { ...item, linkedPrs: item.linkedPrs.map((p) => ({ ...p, intoHead: head })) }
}

/** A worker that does `act` in the clone, then stops, writing `status` when given. */
const resolver = (
  act: (dir: string, skill: string) => Promise<unknown>,
  prompts: string[] = [],
): Provider => ({
  ...fakeProvider('claude'),
  async *run(job) {
    prompts.push(job.prompt)
    await act(job.dir, job.unit.skill)
    yield { type: 'done', ok: true, turns: 1 }
  },
})

/** Resolves `a.txt` keeping both sides, and says so. */
const bothSides = async (dir: string) => {
  await writeFile(join(dir, 'a.txt'), 'mine\ntheirs\n')
  await writeFile(join(dir, '.away/out/pr.md'), 'a.txt: kept both lines.\n')
}

const resolving = parseConfig(`
providers: [claude: {}]
sources: { github: { repos: [acme/*] } }
queue:
  - skill: sync
    where: { type: pr, mine: true, behind: { gt: 0 } }
    deliver: push
gates:
  db: { changed: ["db/**"] }
  db-diff: { command: 'git diff --quiet "$AWAYWORK_FROM" HEAD -- db' }
  resolved: { changed: ["a.txt"] }
repos:
  acme/api:
    setup: 'true'
    verify: 'test -f db/schema.sql'
`)

/** An origin with `main` holding `common` and your `feature-1` off it, `main` then moved on by `base`'s commits, each a file, deleted when null. */
async function origin(
  base: Record<string, string | null>,
  feature: Record<string, string> = {},
  common: Record<string, string> = {},
) {
  const root = await mkdtemp(join(tmpdir(), 'awaywork-sync-'))
  const origin = join(root, 'origin')
  await execa(bin('git'), ['init', '-q', '-b', 'main', origin])
  await git(origin, 'commit', '-q', '--allow-empty', '-m', 'init')
  const commit = async (files: Record<string, string | null>) => {
    for (const [name, text] of Object.entries(files)) {
      if (text === null) await git(origin, 'rm', '-q', name)
      else {
        await mkdir(dirname(join(origin, name)), { recursive: true })
        await writeFile(join(origin, name), text)
        await git(origin, 'add', name)
      }
      await git(origin, 'commit', '-qm', name)
    }
  }
  await commit(common)
  await git(origin, 'checkout', '-qb', 'feature-1')
  await commit({ 'feature.txt': 'mine', ...feature })
  await git(origin, 'checkout', '-q', 'main')
  await commit(base)
  const fastForwards: string[] = []
  const forge = {
    ...fakeForge(),
    clone: async (_repo: string, branch: string, dir: string) => {
      await execa(bin('git'), ['clone', '-q', '--branch', branch, origin, dir])
      await git(dir, 'config', 'user.name', 'Dev')
      await git(dir, 'config', 'user.email', 'dev@example.com')
    },
    fastForward: async (dir: string, branch: string, from: string) => {
      fastForwards.push(`${branch} from ${from.slice(0, 7)}`)
      if ((await git(origin, 'rev-parse', branch)) !== from) return `${branch} moved`
      await git(dir, 'push', '-q', origin, `HEAD:refs/heads/${branch}`)
    },
  }
  const feature1 = await git(origin, 'rev-parse', 'feature-1')
  const main = await git(origin, 'rev-parse', 'main')
  return { root, origin, forge, fastForwards, feature1, main }
}

async function sync(
  at: Awaited<ReturnType<typeof origin>>,
  item = pr(),
  settings = config,
  worker = noWorker,
) {
  const plan = planRun({
    config: settings,
    items: [item],
    allowances: { claude: allowance(settings.budget, null, 0, settings.windows) },
    skills: { builtin: builtinSkills },
  })
  const report = await runUnits({
    config: settings,
    configDir: at.root,
    plan,
    runId: 'r1',
    runDir: join(at.root, 'run'),
    dryRun: false,
    providers: { claude: worker },
    sources: { github: fakeSource() as Source },
    forge: at.forge,
    ctx: { env: { PATH: process.env.PATH }, log: () => {} },
    watch: () => ({ stop: async () => {} }),
    shortage: async () => undefined,
    skillDirs: { user: join(at.root, 'none'), builtin: builtinSkillsDir },
  })
  return { plan, report }
}

describe('sync', () => {
  it('plans a merge with no provider and no gates, but on a conflict read, and skips a PR whose base it can not read', () => {
    const plan = (item: Item) =>
      planRun({
        config,
        items: [item],
        allowances: { claude: allowance(config.budget, null, 0, config.windows) },
        skills: { builtin: builtinSkills },
      }).units.map((p) => [p.unit.merge, p.unit.deliver, p.provider, p.unit.gates])
    expect(plan(pr())).toEqual([['main', 'push', undefined, undefined]])
    expect(plan(pr({ conflicts: undefined }))).toEqual([['main', 'push', undefined, undefined]])
    expect(plan(pr({ conflicts: true }))).toEqual([
      [
        'main',
        'push',
        'claude',
        { anything: { changed: ['**'], commands: [], skills: [], instructions: [] } },
      ],
    ])
    const why = (item: Item) =>
      formatWhy(planRun({ config, items: [item], allowances: {}, skills }), item)
    expect(why(pr())).toContain('provider  none, awaywork merges')
    // With no quota left, the run merges what's clean and skips a conflict.
    expect(why(pr({ conflicts: true }))).toContain(
      'provider  none left: the merge runs, a conflict waits',
    )
    const unread = { ...pr(), linkedPrs: pr().linkedPrs.map(({ into: _, ...p }) => p) }
    const skipped = planRun({
      config,
      items: [unread],
      allowances: {},
      skills: { builtin: builtinSkills },
    }).skipped
    expect(skipped.map((s) => [s.kind, s.reason])).toEqual([
      [
        'refused_delivery',
        'sync: https://github.com/acme/api/pull/1 names no base branch to merge',
      ],
    ])
  })

  it("refuses a merging skill of yours that doesn't push", () => {
    const own = parseConfig(`
providers: [claude: {}]
sources: { github: { repos: [acme/*] } }
queue: [{ skill: catch-up, where: { type: pr } }]
`)
    const { skipped } = planRun({
      config: own,
      items: [pr()],
      allowances: {},
      skills: { user: { 'catch-up': { merge: true } }, builtin: builtinSkills },
    })
    expect(skipped.map((s) => s.reason)).toEqual([
      "catch-up merges your PR's base: it needs deliver: push, no then",
    ])
  })

  it('pushes a clean merge of the base onto your PR, its trailer on the merge alone, with no worker and no hold', async () => {
    const at = await origin({ 'base-1.txt': '1', 'base-2.txt': '2' })
    const { plan, report } = await sync(at)
    const [result] = report.results
    expect(result).toMatchObject({
      status: 'done',
      made: 'a merge of 2 commits',
      outcome: {
        kind: 'pushed',
        branch: 'feature-1',
        commits: 1,
        text: `Merge main into feature-1: 2 commits, main at ${at.main.slice(0, 7)}.`,
      },
    })
    expect(result?.provider).toBeUndefined()
    expect(result?.outcome).not.toHaveProperty('gated')
    expect(at.fastForwards).toEqual([`feature-1 from ${at.feature1.slice(0, 7)}`])
    const head = await git(at.origin, 'rev-parse', 'feature-1')
    expect(await git(at.origin, 'rev-parse', `${head}^@`)).toBe(`${at.feature1}\n${at.main}`)
    const log = await git(
      at.origin,
      'log',
      '--first-parent',
      '--format=%s|%an|%(trailers:key=Awaywork,valueonly)',
      'feature-1',
    )
    expect(log.split('\n').filter(Boolean)).toEqual([
      'Merge main into feature-1|Dev|r1',
      'feature.txt|t|',
      'init|t|',
    ])
    const out = join(at.root, 'run/units/acme-api-1')
    expect(await readFile(join(out, 'out/verify.log'), 'utf8')).toContain('test -f base-2.txt')
    expect(await readFile(join(out, '1-sync/setup.txt'), 'utf8')).toBe('ran\n')
    expect(formatReport(report)).toContain(
      '| 1 | [api#1 PR 1](https://github.com/acme/api/pull/1) | sync | - | done | 1 commit pushed onto feature-1, report below |',
    )
    const attempts = recordAttempts({}, report)
    expect(attempts['github:acme/api#1']).not.toHaveProperty('pushed')
    const after = { ...pr(), linkedPrs: pr().linkedPrs.map((p) => ({ ...p, head })) }
    expect(pushedOnto([after], attempts)).toBeUndefined()
    expect(plan.units).toHaveLength(1)
  })

  it('aborts a merge that conflicts with no provider planned, pushes nothing, reports the paths and records no attempt', async () => {
    const at = await origin(
      { 'a.txt': 'theirs', 'b.txt': 'theirs' },
      { 'a.txt': 'mine', 'b.txt': 'mine' },
    )
    // Setup runs after the merge: attributes it writes can't turn the conflict into a clean merge.
    const union = withRepo('echo "* merge=union" > .gitattributes', 'true')
    const { report } = await sync(at, onBase(at.main), union)
    const reason = 'conflicts with main in a.txt, b.txt, and no provider to resolve them'
    expect(report.results.map((r) => [r.status, r.reason, r.outcome])).toEqual([
      ['skipped', reason, undefined],
    ])
    expect(at.fastForwards).toEqual([])
    expect(await git(at.origin, 'rev-parse', 'feature-1')).toBe(at.feature1)
    const log = await readFile(join(at.root, 'run/units/acme-api-1/1-sync/worker.log'), 'utf8')
    expect(log).toContain('git merge main')
    expect(formatReport(report)).toContain(`| sync | - | skipped | ${reason} |`)
    // The next run, reading the conflict, plans a provider for it.
    expect(recordAttempts({}, report)).toEqual({})
  })

  it("retries an issue's PR already up to date once its base moves", async () => {
    const at = await origin({})
    const byIssue = parseConfig(`
providers: [claude: {}]
sources: { github: { repos: [acme/*] } }
queue: [{ skill: sync, where: { type: issue }, deliver: push }]
`)
    const issue = (head: string): Item => ({
      ...onBase(head),
      type: 'issue',
      key: 'acme/api#9',
      url: 'https://github.com/acme/api/issues/9',
    })
    const { report } = await sync(at, issue(at.main), byIssue)
    expect(report.results.map((r) => r.outcome)).toEqual([
      { kind: 'none', reason: 'already up to date with main' },
    ])
    const attempts = recordAttempts({}, report)
    expect(attempts['github:acme/api#9']).toMatchObject({ base: at.main })
    expect(unchangedSince(issue(at.main), 'sync', attempts)).toBe('r1')
    // A base push leaves the PR's updated time as it was.
    expect(unchangedSince(issue('f00d'), 'sync', attempts)).toBeUndefined()
  })

  it("has a worker resolve a conflict read at plan time, and pushes awaywork's merge of it, gated on the resolution alone and held", async () => {
    const at = await origin(
      { 'a.txt': 'theirs', 'db/schema.sql': 'v2', 'base-1.txt': '1' },
      { 'a.txt': 'mine' },
    )
    const prompts: string[] = []
    const seen: Record<string, string> = {}
    const worker = resolver(async (dir) => {
      seen.conflict = await readFile(join(dir, 'a.txt'), 'utf8')
      seen.context = await readFile(join(dir, '.away/context/merge.md'), 'utf8')
      await bothSides(dir)
    }, prompts)
    const item = onBase(at.main, { conflicts: true })
    const { plan, report } = await sync(at, item, resolving, worker)
    expect(plan.units.map((p) => p.provider)).toEqual(['claude'])
    expect(seen.conflict).toMatch(/^<<<<<<< HEAD\nmine\n=======\ntheirs\n>>>>>>> /)
    const touching = await git(at.origin, 'log', '-1', '--format=%h a.txt', 'main', '--', 'a.txt')
    expect(seen.context).toBe(
      `awaywork merged \`main\` (at ${at.main.slice(0, 7)}, 3 commits) into \`feature-1\`, and these files conflict:\n\n- a.txt\n\nThe commits on \`main\` that touch them, newest first:\n\n- ${touching}\n`,
    )
    expect(prompts[0]).toContain(
      "Deliver: the merge of `main` into `feature-1`, the developer's own pull request, which awaywork started in this clone and commits and pushes itself from your working tree. Commit nothing",
    )
    const [result] = report.results
    expect(result).toMatchObject({
      status: 'done',
      provider: 'claude',
      made: 'a merge of 3 commits, its conflicts resolved',
      outcome: { kind: 'pushed', branch: 'feature-1', commits: 1, gated: 'gate resolved fired' },
    })
    expect(result?.outcome).toMatchObject({
      text: '## Needs a decision\n\n### Gates (from scripts)\n\n- resolved: a.txt\n\n---\n\nResolved: a.txt\n\na.txt: kept both lines.',
    })
    const head = await git(at.origin, 'rev-parse', 'feature-1')
    expect(await git(at.origin, 'rev-parse', `${head}^@`)).toBe(`${at.feature1}\n${at.main}`)
    expect(await git(at.origin, 'show', `${head}:a.txt`)).toBe('mine\ntheirs')
    expect(await git(at.origin, 'ls-tree', '-r', '--name-only', head)).toBe(
      'a.txt\nbase-1.txt\ndb/schema.sql\nfeature.txt',
    )
    const log = await git(
      at.origin,
      'log',
      '--first-parent',
      '--format=%s|%(trailers:key=Awaywork,valueonly)',
      'feature-1',
    )
    expect(log.split('\n').filter(Boolean)).toEqual([
      'Merge main into feature-1|r1',
      'a.txt|',
      'feature.txt|',
      'init|',
    ])
    const out = join(at.root, 'run/units/acme-api-1/out')
    expect(await readFile(join(out, 'verify.log'), 'utf8')).toContain('passed')
    // A resolution is the model's work: the PR waits for your review.
    const attempts = recordAttempts({}, report)
    expect(attempts['github:acme/api#1']).toMatchObject({ pushed: head })
    const after = { ...item, linkedPrs: item.linkedPrs.map((p) => ({ ...p, head })) }
    expect(pushedOnto([after], attempts)?.url).toBe('https://github.com/acme/api/pull/1')
  })

  it("merges with no worker when a conflict read at plan time doesn't happen", async () => {
    const at = await origin({ 'base-1.txt': '1', 'base-2.txt': '2' })
    const { report } = await sync(at, pr({ conflicts: true }))
    const [result] = report.results
    expect(result).toMatchObject({ status: 'done', outcome: { kind: 'pushed', commits: 1 } })
    expect(result?.provider).toBeUndefined()
    expect(result?.outcome).not.toHaveProperty('gated')
    expect(recordAttempts({}, report)['github:acme/api#1']).not.toHaveProperty('pushed')
  })

  const moved = 'HEAD moved since the clone: awaywork makes the merge, not pushed'
  it.each([
    [
      'the worker commits',
      async (dir: string) => {
        await bothSides(dir)
        await git(dir, 'commit', '-qam', 'resolved')
      },
      moved,
    ],
    ['setup commits', bothSides, moved, withRepo('git add -A && git commit -qm setup', 'true')],
    [
      'the worker leaves markers',
      (dir: string) => writeFile(join(dir, '.away/out/pr.md'), 'Done.\n'),
      'conflict markers left in a.txt, not pushed',
    ],
    [
      'the worker drops the base',
      async (dir: string) => {
        await git(dir, 'merge', '--abort')
        await writeFile(join(dir, '.away/out/pr.md'), 'Kept mine.\n')
      },
      'the resolution keeps nothing of main, not pushed',
    ],
    [
      'the worker drops the base, then edits a conflicted file',
      async (dir: string) => {
        await git(dir, 'merge', '--abort')
        await writeFile(join(dir, 'a.txt'), 'merged\n')
        await writeFile(join(dir, '.away/out/pr.md'), 'a.txt: merged.\n')
      },
      "the resolution undoes main's change to b.txt, not pushed",
    ],
  ])('pushes nothing when %s', async (_, act, reason, settings = resolving) => {
    const at = await origin({ 'a.txt': 'theirs', 'b.txt': 'base work' }, { 'a.txt': 'mine' })
    const { report } = await sync(at, onBase(at.main, { conflicts: true }), settings, resolver(act))
    expect(report.results.map((r) => [r.status, r.outcome])).toEqual([
      ['done', { kind: 'none', reason, unpublished: true }],
    ])
    expect(at.fastForwards).toEqual([])
    expect(await git(at.origin, 'rev-parse', 'feature-1')).toBe(at.feature1)
    expect(recordAttempts({}, report)['github:acme/api#1']).toMatchObject({ failed: 1 })
  })

  it('merges on exactly the clone and the base it read, whatever the worker wrote to MERGE_HEAD', async () => {
    const at = await origin({ 'a.txt': 'theirs' }, { 'a.txt': 'mine' })
    const worker = resolver(async (dir) => {
      await bothSides(dir)
      await writeFile(join(dir, '.git/MERGE_HEAD'), `${at.feature1}\n`)
      await writeFile(join(dir, '.git/info/exclude'), '')
    })
    const { report } = await sync(at, onBase(at.main, { conflicts: true }), resolving, worker)
    expect(report.results[0]?.outcome?.kind).toBe('pushed')
    const head = await git(at.origin, 'rev-parse', 'feature-1')
    expect(await git(at.origin, 'rev-parse', `${head}^@`)).toBe(`${at.feature1}\n${at.main}`)
    // Neither `.away/` nor awaywork's skill copy, which the emptied exclude no longer ignores.
    expect(await git(at.origin, 'ls-tree', '-r', '--name-only', head)).toBe('a.txt\nfeature.txt')
  })

  it("pushes only the files of git's merge, listing the untracked ones setup and the worker left out", async () => {
    const at = await origin({ 'a.txt': 'theirs' }, { 'a.txt': 'mine' })
    const worker = resolver(async (dir) => {
      await bothSides(dir)
      await writeFile(join(dir, 'scratch.log'), 'checks ran\n')
      await writeFile(join(dir, 'über.log'), 'checks ran\n')
    })
    const settings = withRepo('echo gen > generated.txt', 'true')
    const { report } = await sync(at, onBase(at.main, { conflicts: true }), settings, worker)
    expect(report.results[0]?.outcome).toMatchObject({
      kind: 'pushed',
      text: expect.stringContaining(
        'Resolved: a.txt\n\nLeft out, untracked: generated.txt, scratch.log, über.log\n\na.txt: kept both lines.',
      ),
    })
    const head = await git(at.origin, 'rev-parse', 'feature-1')
    expect(await git(at.origin, 'ls-tree', '-r', '--name-only', head)).toBe('a.txt\nfeature.txt')
  })

  it('refuses markers longer than the default, as conflict-marker-size makes them', async () => {
    const at = await origin(
      { 'a.txt': 'theirs' },
      { '.gitattributes': 'a.txt conflict-marker-size=10\n', 'a.txt': 'mine' },
    )
    let seen = ''
    const worker = resolver(async (dir) => {
      seen = await readFile(join(dir, 'a.txt'), 'utf8')
      await writeFile(join(dir, '.away/out/pr.md'), 'Done.\n')
    })
    const { report } = await sync(at, onBase(at.main, { conflicts: true }), config, worker)
    expect(seen).toMatch(/^<{10} HEAD\n/)
    expect(report.results[0]?.outcome).toEqual({
      kind: 'none',
      reason: 'conflict markers left in a.txt, not pushed',
      unpublished: true,
    })
  })

  const refused = { kind: 'none', reason: 'conflict markers left in a.txt, not pushed' }
  it.each([
    [
      'pushes the markers a.txt already had',
      'fixture',
      { text: expect.stringContaining('Resolved: a.txt') },
    ],
    ['refuses a marker repeated past what a.txt had', 'fixture\n<<<<<<< ours', refused],
    [
      'refuses the conflict left beside them',
      '<<<<<<< HEAD\nmine\n=======\ntheirs\n>>>>>>> main',
      refused,
    ],
  ])('%s', async (_, kept, outcome) => {
    const fixture = '<<<<<<< ours\nfixture\n>>>>>>> theirs\n'
    const at = await origin(
      { 'a.txt': `${fixture}theirs\n` },
      { 'a.txt': `${fixture}mine\n` },
      { 'a.txt': `${fixture}line\n` },
    )
    const worker = resolver(async (dir) => {
      const resolved = `<<<<<<< ours\n${kept}\n>>>>>>> theirs\nmine\ntheirs\n`
      await writeFile(join(dir, 'a.txt'), resolved)
      await writeFile(join(dir, '.away/out/pr.md'), 'a.txt: kept both lines.\n')
    })
    const { report } = await sync(at, onBase(at.main, { conflicts: true }), config, worker)
    expect(report.results[0]?.outcome).toMatchObject(outcome)
  })

  it.each([
    ['a binary file both sides added', { 'b.bin': 'theirs\0' }, { 'b.bin': 'mine\0' }, {}, 'b.bin'],
    [
      'a name git would quote',
      { 'café.bin': 'theirs\0' },
      { 'café.bin': 'mine\0' },
      {},
      'café.bin',
    ],
    [
      'a file the base deleted',
      { 'm.txt': null },
      { 'm.txt': 'mine' },
      { 'm.txt': 'old' },
      'm.txt',
    ],
  ])(
    'gates the conflicted paths the worker left as git did: %s',
    async (_, base, feature, common, path) => {
      const at = await origin({ ...base, 'base-2.txt': '2' }, feature, common)
      const worker = resolver((dir) =>
        writeFile(join(dir, '.away/out/pr.md'), `${path}: kept mine.\n`),
      )
      const { report } = await sync(at, onBase(at.main, { conflicts: true }), config, worker)
      expect(report.results[0]?.outcome).toMatchObject({
        kind: 'pushed',
        gated: 'gate anything fired',
        text: `## Needs a decision\n\n### Gates (from scripts)\n\n- anything: ${path}\n\n---\n\nResolved: ${path}\n\n${path}: kept mine.`,
      })
    },
  )

  it.each([
    [
      'refuses markers left',
      false,
      { kind: 'none', reason: 'conflict markers left in café.txt, not pushed' },
    ],
    [
      'pushes your side kept',
      true,
      {
        kind: 'pushed',
        text: expect.stringContaining('- anything: café.txt\n\n---\n\nResolved: café.txt\n'),
      },
    ],
  ])('reads a conflicted name git would quote, and %s', async (_, keep, outcome) => {
    const at = await origin({ 'café.txt': 'theirs', 'base-2.txt': '2' }, { 'café.txt': 'mine' })
    let context = ''
    const worker = resolver(async (dir) => {
      context = await readFile(join(dir, '.away/context/merge.md'), 'utf8')
      await writeFile(join(dir, '.away/out/pr.md'), 'Done.\n')
      if (keep) await writeFile(join(dir, 'café.txt'), 'mine')
    })
    const { report } = await sync(at, onBase(at.main, { conflicts: true }), config, worker)
    expect(context).toMatch(/- café\.txt\n\n.*\n\n- \w+ café\.txt\n/)
    expect(report.results[0]?.outcome).toMatchObject(outcome)
  })

  it('refuses a resolution that puts back what the base changed outside the conflicts', async () => {
    const at = await origin(
      { 'a.txt': 'theirs', 'db/schema.sql': 'v2', 'x.txt': 'new' },
      { 'a.txt': 'mine' },
      { 'x.txt': 'old' },
    )
    const worker = resolver(async (dir) => {
      await bothSides(dir)
      await rm(join(dir, 'db/schema.sql'))
      await writeFile(join(dir, 'x.txt'), 'old')
    })
    const { report } = await sync(at, onBase(at.main, { conflicts: true }), resolving, worker)
    expect(report.results[0]?.outcome).toEqual({
      kind: 'none',
      reason: "the resolution undoes main's change to db/schema.sql, x.txt, not pushed",
      unpublished: true,
    })
    expect(at.fastForwards).toEqual([])
  })

  it('lists what else the merge carries besides the conflicted paths', async () => {
    const at = await origin({ 'a.txt': 'theirs', 'b.txt': 'base work' }, { 'a.txt': 'mine' })
    const worker = resolver(async (dir) => {
      await bothSides(dir)
      await writeFile(join(dir, 'b.txt'), 'base work, fixed')
    })
    const settings = withRepo('echo setup >> feature.txt', 'true')
    const { report } = await sync(at, onBase(at.main, { conflicts: true }), settings, worker)
    expect(report.results[0]?.outcome).toMatchObject({
      kind: 'pushed',
      text: expect.stringContaining(
        'Resolved: a.txt\n\nAlso changed: b.txt, feature.txt\n\na.txt: kept both lines.',
      ),
    })
  })

  it('leaves a conflicted submodule to you, with no worker and no attempt', async () => {
    const at = await origin({})
    const gitlink = async (branch: string, sha: string) => {
      await git(at.origin, 'checkout', '-q', branch)
      await git(at.origin, 'update-index', '--add', '--cacheinfo', `160000,${sha},sub`)
      await git(at.origin, 'commit', '-qm', `sub on ${branch}`)
    }
    await gitlink('main', at.main)
    await gitlink('feature-1', at.feature1)
    const main = await git(at.origin, 'rev-parse', 'main')
    const { report } = await sync(at, onBase(main, { conflicts: true }), config, noWorker)
    expect(report.results.map((r) => [r.status, r.provider, r.outcome])).toEqual([
      [
        'done',
        undefined,
        { kind: 'none', reason: 'conflicts with main in sub (a submodule): merge it by hand' },
      ],
    ])
    expect(at.fastForwards).toEqual([])
    expect(recordAttempts({}, report)['github:acme/api#1']).not.toHaveProperty('failed')
  })

  // BADBYTE is `b\xff`, a name APFS refuses; `b�` is how git's listing of it reads.
  it.each([['b�'], ...(process.platform === 'linux' ? [['BADBYTE']] : [])])(
    'leaves a conflict in a file named %j to you, with no worker and no attempt',
    async (name) => {
      const at = await origin({})
      const both = `n=$1; [ "$n" = BADBYTE ] && n=$'b\\xff'
for b in main feature-1; do git checkout -q $b && echo $b > "$n" && git add -A && git -c user.name=t -c user.email=t@t commit -qm "$b"; done`
      await execa('bash', ['-c', both, 'bash', name], { cwd: at.origin })
      const main = await git(at.origin, 'rev-parse', 'main')
      const { report } = await sync(at, onBase(main, { conflicts: true }), config, noWorker)
      expect(report.results.map((r) => [r.status, r.provider, r.outcome])).toEqual([
        [
          'done',
          undefined,
          {
            kind: 'none',
            reason: "conflicts with main in a file whose name isn't UTF-8: merge it by hand",
          },
        ],
      ])
      expect(at.fastForwards).toEqual([])
      expect(recordAttempts({}, report)['github:acme/api#1']).not.toHaveProperty('failed')
    },
  )

  it('lets the worker resolve a merge whose conflicted tree fails setup', async () => {
    const at = await origin({ 'a.txt': 'theirs', 'db/schema.sql': 'v2' }, { 'a.txt': 'mine' })
    let context = ''
    const worker = resolver(async (dir) => {
      context = await readFile(join(dir, '.away/context/merge.md'), 'utf8')
      await bothSides(dir)
    })
    const failing = withRepo('grep -q "<<<<<<<" a.txt && exit 1; true', 'true')
    const { report } = await sync(at, onBase(at.main, { conflicts: true }), failing, worker)
    expect(context).toContain('Setup failed on the conflicted tree: run `grep')
    expect(report.results[0]?.outcome?.kind).toBe('pushed')
  })

  it("has a gate's judge read the resolution from git's automatic merge", async () => {
    const at = await origin({ 'a.txt': 'theirs' }, { 'a.txt': 'mine' })
    const judged = parseConfig(`
providers: [claude: {}]
sources: { github: { repos: [acme/*] } }
queue: [{ skill: sync, where: { type: pr }, deliver: push }]
gates: { risk: { skill: judge } }
`)
    const prompts: string[] = []
    const worker = resolver(
      (dir, skill) =>
        skill === 'judge' ? writeFile(join(dir, '.away/out/verdict'), 'clear\n') : bothSides(dir),
      prompts,
    )
    const { report } = await sync(at, onBase(at.main, { conflicts: true }), judged, worker)
    expect(report.results[0]?.outcome?.kind).toBe('pushed')
    const automatic = /`([0-9a-f]{40})` is git's automatic merge/.exec(prompts[1] ?? '')?.[1]
    expect(prompts[1]).toContain(`\`git diff ${automatic} HEAD\` is what that agent wrote`)
    expect(prompts[1]).toContain('The conflicts were in `a.txt`: what HEAD holds there is')
    // A local commit of awaywork's, never pushed.
    await expect(git(at.origin, 'cat-file', '-e', `${automatic}`)).rejects.toThrow()
  })

  it('pushes nothing when the worker asks', async () => {
    const at = await origin({ 'a.txt': 'theirs' }, { 'a.txt': 'mine' })
    const worker = resolver(async (dir) => {
      await bothSides(dir)
      await writeFile(join(dir, '.away/out/questions.md'), 'Which line wins?\n')
      await writeFile(join(dir, '.away/out/status'), 'ask\n')
    })
    const { report } = await sync(at, onBase(at.main, { conflicts: true }), resolving, worker)
    expect(report.results.map((r) => [r.status, r.outcome, r.questions?.text])).toEqual([
      ['done', { kind: 'none', reason: 'asked questions' }, 'Which line wins?'],
    ])
    expect(at.fastForwards).toEqual([])
    expect(await git(at.origin, 'rev-parse', 'feature-1')).toBe(at.feature1)
  })

  it('pushes nothing on a branch already up to date with its base', async () => {
    const at = await origin({})
    const { report } = await sync(at)
    expect(report.results.map((r) => [r.status, r.outcome])).toEqual([
      ['done', { kind: 'none', reason: 'already up to date with main' }],
    ])
    expect(at.fastForwards).toEqual([])
  })

  it.each([
    ['amends the merge', 'git commit -q --amend --no-edit'],
    ['commits on top of the merge', 'git commit -qm sneaky'],
  ])('pushes nothing when verify %s', async (_, how) => {
    const verify = `echo evil > evil.txt && git add evil.txt && ${how}`
    const at = await origin({ 'base-1.txt': '1', 'verify.sh': verify })
    const { report } = await sync(at, pr(), withRepo('true', 'sh verify.sh'))
    expect(report.results.map((r) => [r.status, r.outcome?.kind])).toEqual([['done', 'none']])
    expect(report.results[0]?.outcome).toMatchObject({
      reason: expect.stringMatching(/^the clone's head isn't awaywork's merge \w{7} any more/),
    })
    expect(at.fastForwards).toEqual([])
    expect(await git(at.origin, 'rev-parse', 'feature-1')).toBe(at.feature1)
  })

  it('says a base gone before the clone is gone', async () => {
    const at = await origin({ 'base-1.txt': '1' })
    const item = pr()
    const gone = { ...item, linkedPrs: item.linkedPrs.map((p) => ({ ...p, into: 'gone' })) }
    const { report } = await sync(at, gone)
    expect(report.results.map((r) => [r.status, r.reason])).toEqual([
      ['error', 'base gone is gone: nothing to merge'],
    ])
  })
})
