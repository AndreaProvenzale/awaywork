import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execa } from 'execa'
import { describe, expect, it } from 'vitest'
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

const git = async (dir: string, ...args: string[]) =>
  (await execa(bin('git'), ['-C', dir, '-c', 'user.name=t', '-c', 'user.email=t@t', ...args]))
    .stdout

const config = parseConfig(`
providers: [claude: {}]
sources: { github: { repos: [acme/*] } }
queue:
  - skill: sync
    where: { type: pr, mine: true, behind: { gt: 0 }, conflicts: false }
    deliver: push
gates:
  anything: { changed: ["**"] }
repos:
  acme/api:
    setup: 'echo ran >> .away/setup.txt'
    verify: 'test -f base-2.txt'
`)

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

/** An origin with `main` and your `feature-1` off it, `main` then moved on by `base`'s commits, each a file. */
async function origin(base: Record<string, string>, feature: Record<string, string> = {}) {
  const root = await mkdtemp(join(tmpdir(), 'awaywork-sync-'))
  const origin = join(root, 'origin')
  await execa(bin('git'), ['init', '-q', '-b', 'main', origin])
  await git(origin, 'commit', '-q', '--allow-empty', '-m', 'init')
  const commit = async (files: Record<string, string>) => {
    for (const [name, text] of Object.entries(files)) {
      await writeFile(join(origin, name), text)
      await git(origin, 'add', name)
      await git(origin, 'commit', '-qm', name)
    }
  }
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

async function sync(at: Awaited<ReturnType<typeof origin>>, item = pr()) {
  const plan = planRun({
    config,
    items: [item],
    allowances: { claude: allowance(config.budget, null, 0, config.windows) },
    skills: { builtin: builtinSkills },
  })
  const report = await runUnits({
    config,
    configDir: at.root,
    plan,
    runId: 'r1',
    runDir: join(at.root, 'run'),
    dryRun: false,
    providers: { claude: noWorker },
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
  it('plans a merge with no provider and no gates, and skips a PR whose base it can not read', () => {
    const plan = planRun({
      config,
      items: [pr()],
      allowances: { claude: allowance(config.budget, null, 0, config.windows) },
      skills: { builtin: builtinSkills },
    })
    expect(plan.units.map((p) => [p.unit.merge, p.unit.deliver, p.provider, p.unit.gates])).toEqual(
      [['main', 'push', undefined, undefined]],
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
      skills: { user: { 'catch-up': { merge: 'base' } }, builtin: builtinSkills },
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

  it('aborts a merge that conflicts, pushes nothing and reports the paths, once until the PR changes', async () => {
    const at = await origin(
      { 'a.txt': 'theirs', 'b.txt': 'theirs' },
      { 'a.txt': 'mine', 'b.txt': 'mine' },
    )
    const { report } = await sync(at)
    expect(report.results.map((r) => [r.status, r.outcome])).toEqual([
      ['done', { kind: 'none', reason: 'conflicts with main in a.txt, b.txt: merge it by hand' }],
    ])
    expect(at.fastForwards).toEqual([])
    expect(await git(at.origin, 'rev-parse', 'feature-1')).toBe(at.feature1)
    const log = await readFile(join(at.root, 'run/units/acme-api-1/1-sync/worker.log'), 'utf8')
    expect(log).toContain('git merge main')
    expect(formatReport(report)).toContain(
      '| sync | - | done | conflicts with main in a.txt, b.txt: merge it by hand |',
    )
    const attempts = recordAttempts({}, report)
    expect(attempts['github:acme/api#1']).not.toHaveProperty('failed')
    expect(unchangedSince(pr(), 'sync', attempts)).toBe('r1')
  })

  it('pushes nothing on a branch already up to date with its base', async () => {
    const at = await origin({})
    const { report } = await sync(at)
    expect(report.results.map((r) => [r.status, r.outcome])).toEqual([
      ['done', { kind: 'none', reason: 'already up to date with main' }],
    ])
    expect(at.fastForwards).toEqual([])
  })
})
