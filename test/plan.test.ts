import { mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { describeAllowance, formatPlan, planJson } from '../src/cli/format.js'
import { parseConfig } from '../src/config/load.js'
import { type Attempts, loadAttempts, recordAttempts, saveAttempts } from '../src/core/attempts.js'
import { renderBranch, templateProblem } from '../src/core/branch.js'
import { type Allowance, allowance } from '../src/core/budget.js'
import { type PlannedUnit, planNight } from '../src/core/foreman.js'
import { type NightReport, summarize } from '../src/core/report.js'
import { builtinSkills, type SkillCatalog } from '../src/core/skills.js'
import type { Item, PrRef, Quota } from '../src/core/types.js'
import { asanaTask, fakeItem, githubPr } from './fakes/items.js'

const example = await readFile(new URL('fixtures/example.yml', import.meta.url), 'utf8')
const now = Date.UTC(2026, 0, 1, 1)
const week = (used: number): Quota => ({
  windows: [
    { name: 'five_hour', span: 'short', used: 0.02, resetsAt: now / 1000 + 3 * 3600 },
    { name: 'seven_day', span: 'long', used, resetsAt: now / 1000 + 60 * 3600 },
  ],
})

function plan(
  yaml: string,
  items: Item[],
  quotas: Record<string, Quota | null>,
  skills: SkillCatalog = {},
  attempts: Attempts = {},
) {
  const config = parseConfig(yaml)
  const allowances: Record<string, Allowance> = {}
  for (const p of config.providers)
    allowances[p.id] = allowance(p.budget, quotas[p.id] ?? null, now)
  return planNight({
    config,
    items,
    allowances,
    skills: { builtin: builtinSkills, ...skills },
    attempts,
  })
}
const rows = (p: ReturnType<typeof plan>) =>
  p.units.map((u) => [u.unit.id, u.rule + 1, u.unit.skill, u.provider ?? '-', u.unit.deliver])

const issue = fakeItem({
  source: 'github',
  key: 'acme/api#5',
  type: 'issue',
  title: 'Add rate limits',
  fields: { repo: 'acme/api', label: ['night-shift'] },
})

describe('plan', () => {
  it('orders the example config and explains every placement', () => {
    const pr1 = githubPr(1, { checks: 'failing' })
    const items = [
      githubPr(2, { mine: false, review_requested: true }),
      issue,
      pr1,
      asanaTask(7, { tags: ['backend'] }, { linkedPrs: pr1.linkedPrs }),
      asanaTask(8, { tags: ['backend'] }),
      githubPr(3),
    ]
    const result = plan(example, items, { claude: week(0.36), codex: null })
    expect(rows(result)).toEqual([
      ['acme-api-1', 1, 'fix-ci', 'claude', 'draft_pr'],
      ['acme-api-5', 2, 'implement', 'claude', 'draft_pr'],
      ['acme-api-2', 3, 'review', 'claude', 'report'],
    ])
    expect(result.units[0]?.unit).toMatchObject({
      base: 'feature-1',
      foreign: false,
      branch: 'night/acme-api-1',
    })
    expect(result.units[2]?.unit).toMatchObject({ base: 'feature-2', foreign: true })
    expect(formatPlan(result)).toMatchInlineSnapshot(`
      "Queue
        #1  fix-ci     type=pr mine=true checks=failing
        #2  implement  source=github type=issue label=night-shift repo=acme/api
        #3  review     type=pr review_requested=true
        #4  implement  source=asana section=Ready tags=backend provider=codex

      Providers
        provider  window     used  ceiling  set by     resets in  session / stop at
        claude    seven_day  36%   51%      per_night  3 nights   2% / 90%
          other limits: reserve cap 90%, pacing 54%
        codex     fallback
          4 units, 60 turns each (no quota reading)

      Units
           unit        repo      rule  skill                 provider  deliver   branch
        1  acme-api-1  acme/api  #1    fix-ci (built-in)     claude    draft_pr  night/acme-api-1
           github acme/api#1: PR 1
           + asana T-7: same feature, matched #4
        2  acme-api-5  acme/api  #2    implement (built-in)  claude    draft_pr  night/acme-api-5
           github acme/api#5: Add rate limits
        3  acme-api-2  acme/api  #3    review (built-in)     claude    report    night/acme-api-2
           github acme/api#2: PR 2

      Skipped
        github acme/api#3: matched no rule; closest #1 fix-ci: checks is passing, wants failing
        asana T-8: no repo: no linked PR or repo field"
    `)
    expect(formatPlan(result, [], true)).toBe(formatPlan(result))
  })

  it('uses the default queue for configured sources only', () => {
    const yaml = 'providers: [claude: {}]\nsources: { github: { repos: [acme/*] } }'
    const items = [
      githubPr(1, { mine: false, review_requested: true, trusted: true }),
      githubPr(2, { unresolved_threads: 4 }),
      githubPr(3, { checks: 'failing', unresolved_threads: 2 }),
      githubPr(4, { mine: false, review_requested: true, trusted: false }),
    ]
    const result = plan(yaml, items, { claude: week(0.1) })
    expect(result.defaultQueue).toBe(true)
    expect(result.queue.map((r) => r.skill)).toEqual([
      'fix-ci',
      'address-review',
      'address-review',
      'review',
    ])
    expect(rows(result).map((r) => [r[0], r[2]])).toEqual([
      ['acme-api-3', 'fix-ci'],
      ['acme-api-2', 'address-review'],
      ['acme-api-1', 'review'],
    ])
    expect(result.skipped.map((s) => s.item.key)).toEqual(['acme/api#4'])
  })

  it('names the failing comparison of the closest rule', () => {
    const yaml = `
providers: [claude: {}]
sources: { github: { repos: [acme/api] } }
queue: [{ skill: address-review, where: { unresolved_threads: { gte: 2, lt: 5 } } }]`
    const result = plan(yaml, [githubPr(1, { unresolved_threads: 1 })], { claude: week(0.1) })
    expect(result.skipped.map((s) => s.reason)).toEqual([
      'matched no rule; closest #1 address-review: unresolved_threads is 1, wants >= 2 and < 5',
    ])
    expect(formatPlan(result)).toContain(
      '#1  address-review  unresolved_threads>=2 unresolved_threads<5',
    )
  })

  it('names the failing relative date of the closest rule', () => {
    const yaml = `
providers: [claude: {}]
sources: { github: { repos: [acme/api] } }
queue: [{ skill: fix-ci, where: { updated: { older_than: 3d } } }]`
    const now = new Date().toISOString()
    const result = plan(yaml, [githubPr(1, { updated: now })], { claude: week(0.1) })
    expect(result.skipped.map((s) => s.reason)).toEqual([
      `matched no rule; closest #1 fix-ci: updated is ${now}, wants older than 3d`,
    ])
    expect(formatPlan(result)).toContain('#1  fix-ci  updated:older_than=3d')
  })

  it('routes past a provider at its ceiling and caps fallback units', () => {
    const yaml = `
budget: { fallback: { units: 1, turns: 30 } }
providers: [claude: {}, codex: {}]
sources: { github: { repos: [acme/api] } }
queue:
  - { skill: fix-ci, where: { checks: failing } }
  - { skill: address-review, provider: [codex], where: { unresolved_threads: { not: 0 } } }
`
    const items = [
      githubPr(1, { checks: 'failing' }),
      githubPr(2, { checks: 'failing' }),
      githubPr(3, { unresolved_threads: 1 }),
    ]
    const result = plan(yaml, items, { claude: week(0.95), codex: null })
    expect(rows(result).map((r) => r[3])).toEqual(['codex', '-', '-'])
    expect(result.units[1]?.passed).toEqual([
      'claude at its ceiling (95% of 90%)',
      'codex used its 1 fallback units',
    ])
    expect(formatPlan(result)).toContain(
      'provider: claude at its ceiling (95% of 90%); codex used its 1 fallback units; none left',
    )
  })

  it('routes between claude and codex on their own windows', () => {
    const yaml = `
providers: [claude: {}, codex: { budget: { per_night: 5% } }]
sources: { github: { repos: [acme/api] } }
queue:
  - { skill: fix-ci, where: { checks: failing } }
  - { skill: review, provider: [codex, claude], where: { review_requested: true } }
`
    const items = [githubPr(1, { checks: 'failing' }), githubPr(2, { review_requested: true })]
    const month: Quota = {
      windows: [{ name: '30d', span: 'long', used: 0.04, resetsAt: now / 1000 + 30 * 86400 }],
    }
    const result = plan(yaml, items, { claude: week(0.36), codex: month })
    expect(rows(result).map((r) => r[3])).toEqual(['claude', 'codex'])
    expect(formatPlan(result)).toContain(
      [
        '  codex     30d        4%    6.9%     pacing  30 nights  -',
        '    other limits: per_night 9%, reserve cap 90%',
      ].join('\n'),
    )
    expect(describeAllowance(result.allowances.codex as Allowance)).toBe(
      '30d 4% used, ceiling 6.9% set by pacing (per_night 9%, reserve cap 90%; resets in 30 nights)',
    )

    const full = plan(yaml, items, { claude: week(0.95), codex: month })
    expect(rows(full).map((r) => r[3])).toEqual(['codex', 'codex'])
    expect(full.units[0]?.passed).toEqual(['claude at its ceiling (95% of 90%)'])
  })

  it('resolves skills and delivery: rule, then skill default, then draft_pr', () => {
    const yaml = `
providers: [claude: {}]
sources: { github: { repos: [acme/api] } }
queue:
  - { skill: review, where: { review_requested: true } }
  - { skill: plan, deliver: draft_pr, where: { type: issue } }
  - { skill: our-triage, where: { checks: failing } }
`
    const items = [
      githubPr(1, { review_requested: true }),
      issue,
      githubPr(3, { checks: 'failing' }),
    ]
    const result = plan(yaml, items, { claude: week(0.1) }, { user: { review: {} } })
    expect(result.units.map((u) => [u.unit.skill, u.origin, u.unit.deliver])).toEqual([
      ['review', 'user', 'draft_pr'],
      ['plan', 'builtin', 'draft_pr'],
      ['our-triage', undefined, 'draft_pr'],
    ])
    expect(formatPlan(result)).toContain('our-triage (in-repo?)')
  })

  it("adds the top-level skills to every unit, before the rule's or step's", () => {
    const yaml = `
providers: [claude: {}]
sources: { github: { repos: [acme/api] } }
skills: [house-style]
queue:
  - skill: fix-ci
    skills: [our-api-conventions]
    where: { checks: failing }
    then: { skill: review, skills: [our-review-checklist] }
`
    const units = plan(yaml, [githubPr(1, { checks: 'failing' })], {}).units
    expect(units.map((u) => u.unit.skills)).toEqual([
      ['house-style', 'our-api-conventions'],
      ['house-style', 'our-review-checklist'],
    ])
  })

  it('chains steps: stacked on a draft PR, on the same base after a report', () => {
    const yaml = `
providers: [claude, codex]
sources: { github: { repos: [acme/api] } }
queue:
  - skill: plan
    where: { type: issue }
    model: { claude: opus }
    then:
      - { skill: implement, model: { claude: sonnet }, instructions: notes/impl.md }
      - { skill: review, provider: codex, branch: 'review/{key}' }
  - { skill: fix-ci, where: { checks: failing }, then: review }
`
    const items = [issue, githubPr(3, { checks: 'failing' })]
    const result = plan(yaml, items, { claude: week(0.1), codex: week(0.1) })
    expect(
      result.units.map(({ unit, provider, after }) => [
        unit.id,
        unit.skill,
        provider,
        unit.deliver,
        unit.base,
        unit.branch,
        after,
      ]),
    ).toEqual([
      ['acme-api-5', 'plan', 'claude', 'report', '', 'night/acme-api-5', undefined],
      [
        'acme-api-5-implement',
        'implement',
        'claude',
        'draft_pr',
        '',
        'night/acme-api-5',
        'acme-api-5',
      ],
      [
        'acme-api-5-review',
        'review',
        'codex',
        'report',
        'night/acme-api-5',
        'review/acme-api-5',
        'acme-api-5-implement',
      ],
      ['acme-api-3', 'fix-ci', 'claude', 'draft_pr', 'feature-3', 'night/acme-api-3', undefined],
      [
        'acme-api-3-review',
        'review',
        'claude',
        'report',
        'night/acme-api-3',
        'night/acme-api-3-review',
        'acme-api-3',
      ],
    ])
    expect(result.units[1]?.unit).toMatchObject({
      rule: { model: { claude: 'sonnet' } },
      instructions: ['notes/impl.md'],
    })
    const text = formatPlan(result)
    expect(text).toContain('#1  plan    type=issue model=claude:opus then=implement,review')
    expect(text).toContain(
      '     after acme-api-5-implement\n     github acme/api#5: Add rate limits',
    )
  })

  it('plans every round of a loop on the draft PR before it, or on a fresh clone after a report, and counts it once', () => {
    const yaml = `
night: { start: "01:00", end: "07:00", units: 5 }
providers: [claude, codex]
sources: { github: { repos: [acme/api] } }
queue:
  - skill: implement
    where: { type: issue }
    then:
      - loop: [{ skill: review, provider: codex }, address-review]
        until: { verdict: approve }
        max: 2
      - qa-feedback
  - skill: plan
    where: { checks: failing }
    then: { loop: [implement, review], until: { verdict: approve }, max: 1 }
`
    const items = [issue, githubPr(3, { checks: 'failing' }), githubPr(4, { checks: 'failing' })]
    const result = plan(yaml, items, { claude: week(0.1), codex: week(0.1) })
    const onBranch = (id: string, provider: string, deliver: string, round: string) => [
      id,
      provider,
      deliver,
      '',
      'night/acme-api-5',
      undefined,
      `acme-api-5 ${round}`,
    ]
    expect(
      result.units.map(({ unit, provider, after, loop }) => [
        unit.id,
        provider,
        unit.deliver,
        unit.base,
        unit.branch,
        after,
        loop && `${loop.host} ${loop.round}.${loop.step}`,
      ]),
    ).toEqual([
      ['acme-api-5', 'claude', 'draft_pr', '', 'night/acme-api-5', undefined, undefined],
      onBranch('acme-api-5-review-1', 'codex', 'report', '1.0'),
      onBranch('acme-api-5-address-review-1', 'claude', 'draft_pr', '1.1'),
      onBranch('acme-api-5-review-2', 'codex', 'report', '2.0'),
      onBranch('acme-api-5-address-review-2', 'claude', 'draft_pr', '2.1'),
      [
        'acme-api-5-qa-feedback',
        'claude',
        'draft_pr',
        'night/acme-api-5',
        'night/acme-api-5-qa-feedback',
        'acme-api-5',
        undefined,
      ],
      ['acme-api-3', 'claude', 'report', 'feature-3', 'night/acme-api-3', undefined, undefined],
      [
        'acme-api-3-implement-1',
        'claude',
        'draft_pr',
        'feature-3',
        'night/acme-api-3',
        'acme-api-3',
        'acme-api-3-implement-1 1.0',
      ],
      [
        'acme-api-3-review-1',
        'claude',
        'report',
        'feature-3',
        'night/acme-api-3',
        undefined,
        'acme-api-3-implement-1 1.1',
      ],
    ])
    expect(result.skipped.map((s) => [s.item.key, s.reason])).toEqual([
      ['acme/api#4', 'over the cap: night.units is 5'],
    ])
    const text = formatPlan(result)
    expect(text).toContain('then=loop(review,address-review),qa-feedback')
    expect(text).toContain(
      '     loop review ⇄ address-review until verdict approve, at most 2 rounds; one draft PR from acme-api-5',
    )
    expect(text).not.toContain('acme-api-5-review-2')
  })

  it('lets a loop repeat the skill of the unit it follows', () => {
    const yaml = `
night: { start: "01:00", end: "07:00" }
providers: [claude]
sources: { github: { repos: [acme/api] } }
queue:
  - skill: address-review
    where: { type: pr, unresolved_threads: { gt: 0 } }
    then: { loop: [review, address-review], until: { verdict: approve }, max: 1 }
`
    const result = plan(yaml, [githubPr(3, { unresolved_threads: 2 })], { claude: week(0.1) })
    expect(result.units.map(({ unit, loop }) => [unit.id, unit.branch, loop?.host])).toEqual([
      ['acme-api-3', 'night/acme-api-3', undefined],
      ['acme-api-3-review-1', 'night/acme-api-3', 'acme-api-3'],
      ['acme-api-3-address-review-1', 'night/acme-api-3', 'acme-api-3'],
    ])
  })

  it('routes every round, so a loop holds fallback units up to max', () => {
    const yaml = `
budget: { fallback: { units: 4, turns: 30 } }
providers: [claude]
sources: { github: { repos: [acme/api] } }
queue:
  - skill: implement
    where: { type: pr }
    then: { loop: [review, address-review], until: { verdict: [approve, comments] }, max: 3 }
`
    const result = plan(yaml, [githubPr(1), githubPr(2)], {})
    const routed = result.units.map((u) => [u.unit.id, u.provider ?? '-'])
    expect(routed.slice(0, 8)).toEqual([
      ['acme-api-1', 'claude'],
      ['acme-api-1-review-1', 'claude'],
      ['acme-api-1-address-review-1', 'claude'],
      ['acme-api-1-review-2', 'claude'],
      ['acme-api-1-address-review-2', '-'],
      ['acme-api-1-review-3', '-'],
      ['acme-api-1-address-review-3', '-'],
      ['acme-api-2', '-'],
    ])
    expect(formatPlan(result)).toContain(
      'loop review ⇄ address-review until verdict approve or comments, at most 3 rounds',
    )
    const once = plan(yaml.replace('max: 3', 'max: 1'), [githubPr(1)], {})
    expect(formatPlan(once)).toContain('at most 1 round;')
  })

  it('counts units against the caps as if every loop ended after round 1', () => {
    const yaml = `
night: { start: "01:00", end: "07:00", units: 3 }
budget: { fallback: { units: 6, turns: 30 } }
providers: [claude]
sources: { github: { repos: [acme/api] } }
queue:
  - skill: implement
    where: { type: pr }
    then: { loop: [review, address-review], until: { verdict: approve }, max: 3 }
`
    const result = plan(yaml, [githubPr(1), githubPr(2), githubPr(3)], {})
    expect(result.units.filter((u) => !u.loop || u.loop.round === 1).map((u) => u.unit.id)).toEqual(
      ['acme-api-1', 'acme-api-1-review-1', 'acme-api-1-address-review-1', 'acme-api-2'],
    )
    expect(result.units.find((u) => u.unit.id === 'acme-api-2')?.capped).toBe(
      'then loop: over the cap: night.units is 3',
    )
    expect(result.skipped.map((s) => s.reason)).toEqual(['over the cap: night.units is 3'])
  })

  it("keeps a chain on someone else's PR foreign, and skips it whole on an invalid branch", () => {
    const yaml = (step: string) =>
      `providers: [claude]\nsources: { github: { repos: [acme/api] } }\nqueue: [{ skill: fix-ci, then: ${step} }]`
    const theirs = githubPr(2, { checks: 'failing', mine: false })
    expect(plan(yaml('review'), [theirs], {}).units.map((u) => u.unit.foreign)).toEqual([
      true,
      true,
    ])
    const result = plan(yaml('bad.lock'), [theirs], {})
    expect(result.units).toEqual([])
    expect(result.skipped.map((s) => s.reason)).toEqual([
      'then bad.lock: branch template night/{key} renders an invalid name "night/acme-api-2-bad.lock"',
    ])
  })

  it("pushes only onto your own PR's branch, never onto someone else's or tonight's draft PR", () => {
    const yaml = `
providers: [claude]
sources: { github: { repos: [acme/api] } }
queue:
  - { skill: address-review, where: { type: pr }, deliver: push, then: [{ skill: review, deliver: push }, { skill: implement, deliver: draft_pr }, { skill: fix-ci, deliver: push }] }
  - { skill: implement, where: { type: issue }, deliver: push }
`
    const mine = githubPr(1)
    const theirs = githubPr(2, { mine: false })
    const result = plan(yaml, [mine, theirs, issue], {})
    expect(result.units.map(({ unit }) => [unit.id, unit.deliver, unit.base])).toEqual([
      ['acme-api-1', 'push', 'feature-1'],
      ['acme-api-1-review', 'push', 'feature-1'],
      ['acme-api-1-implement', 'draft_pr', 'feature-1'],
    ])
    expect(result.units[2]?.capped).toBe(
      'then fix-ci: deliver push: night/acme-api-1 is a draft PR opened tonight, not your own PR',
    )
    expect(result.skipped.map((s) => [s.item.key, s.reason])).toEqual([
      ['acme/api#2', "deliver push: feature-2 is someone else's PR"],
      ['acme/api#5', 'deliver push: no PR of yours to push onto'],
    ])
    expect(formatPlan(result)).toMatch(/acme-api-1\s+acme\/api .* push\s+feature-1\n/)
    const relayed = plan(
      `
providers: [claude]
sources: { github: { repos: [acme/api] } }
queue: [{ skill: implement, where: { type: pr }, then: [{ skill: review, deliver: report }, { skill: fix-ci, deliver: push }] }]
`,
      [mine],
      {},
    )
    expect(relayed.units.at(-1)?.capped).toBe(
      'then fix-ci: deliver push: night/acme-api-1 is a draft PR opened tonight, not your own PR',
    )
    const forked = githubPr(3)
    const fork = { ...(forked.linkedPrs[0] as PrRef), fork: true }
    expect(plan(yaml, [{ ...forked, linkedPrs: [fork] }], {}).skipped[0]?.reason).toBe(
      'deliver push: feature-3 is on a fork',
    )
  })

  it("lists a push loop's rounds on the PR branch they push onto", () => {
    const yaml = `
providers: [claude]
sources: { github: { repos: [acme/api] } }
queue:
  - skill: fix-ci
    deliver: push
    then: { loop: [review, implement], until: { verdict: approve }, max: 2 }
`
    expect(formatPlan(plan(yaml, [githubPr(1)], {}))).toMatch(
      /acme-api-1-implement-1\s+acme\/api .* push\s+feature-1\n/,
    )
  })

  it('gathers every instruction file for the unit in prompt order', () => {
    const [first] = plan(example, [githubPr(1, { checks: 'failing' })], {}).units
    expect(first?.unit.instructions).toEqual(['notes/me.md', 'notes/acme-api.md'])
  })

  it('takes network from the rule, then the repo, else on', () => {
    const yaml = `
providers: [claude: {}]
sources: { github: { repos: [acme/*] } }
repos: { acme/web: { network: false } }
queue:
  - { skill: fix-ci, where: { checks: failing }, network: true }
  - { skill: review, where: { review_requested: true }, then: implement, network: false }
  - { skill: implement, where: { type: issue } }
`
    const items = [
      githubPr(1, { mine: false, checks: 'failing' }),
      githubPr(2, { mine: false, review_requested: true }),
      issue,
      fakeItem({ ...issue, key: 'acme/web#5', fields: { repo: 'acme/web' } }),
    ]
    expect(plan(yaml, items, {}).units.map((u) => u.unit.network)).toEqual([
      true,
      false,
      false,
      true,
      false,
    ])
  })

  it('skips units past the night, repo and rule caps, naming the cap', () => {
    const yaml = `
night: { start: "01:00", end: "07:00", units: 4, units_per_repo: 2 }
providers: [claude: {}]
sources: { github: { repos: [acme/*] } }
queue:
  - { skill: fix-ci, where: { checks: failing }, units: 1 }
  - { skill: implement, where: { type: issue } }
`
    const inRepo = (repo: string, n: number) =>
      fakeItem({ source: 'github', key: `${repo}#${n}`, type: 'issue', fields: { repo } })
    const items = [
      githubPr(1, { checks: 'failing' }),
      githubPr(2, { checks: 'failing' }),
      inRepo('acme/api', 3),
      inRepo('acme/api', 4),
      inRepo('acme/web', 5),
      inRepo('acme/app', 6),
      inRepo('acme/ops', 7),
    ]
    const result = plan(yaml, items, { claude: week(0.1) })
    expect(result.units.map((u) => u.unit.id)).toEqual([
      'acme-api-1',
      'acme-api-3',
      'acme-web-5',
      'acme-app-6',
    ])
    expect(result.skipped.map((s) => [s.item.key, s.reason])).toEqual([
      ['acme/api#2', 'over the cap: rule #1 units is 1'],
      ['acme/api#4', 'over the cap: night.units_per_repo is 2'],
      ['acme/ops#7', 'over the cap: night.units is 4'],
    ])
  })

  it("counts then steps against the caps and their rule's units", () => {
    const yaml = `
night: { start: "01:00", end: "07:00", units: 4 }
providers: [claude: {}]
sources: { github: { repos: [acme/*] } }
queue:
  - { skill: implement, where: { type: issue }, units: 3, then: review }
  - { skill: fix-ci, where: { checks: failing } }
`
    const inRepo = (repo: string, n: number) =>
      fakeItem({ source: 'github', key: `${repo}#${n}`, type: 'issue', fields: { repo } })
    const items = [
      inRepo('acme/api', 1),
      inRepo('acme/web', 2),
      inRepo('acme/app', 3),
      githubPr(4, { checks: 'failing' }),
      githubPr(5, { checks: 'failing' }),
    ]
    const result = plan(yaml, items, { claude: week(0.1) })
    expect(result.units.map((u) => u.unit.id)).toEqual([
      'acme-api-1',
      'acme-api-1-review',
      'acme-web-2',
      'acme-api-4',
    ])
    expect(result.units.map((u) => u.capped)).toEqual([
      undefined,
      undefined,
      'then review: over the cap: rule #1 units is 3',
      undefined,
    ])
    expect(formatPlan(result)).toContain(
      '     github acme/web#2: Fix the thing\n     then review: over the cap: rule #1 units is 3',
    )
    const planned = result.units[2] as PlannedUnit
    const report = { runId: 'r1', dryRun: false, startedAt: new Date(0), finishedAt: new Date(0) }
    const results = [{ planned, provider: 'claude', status: 'done' as const, turns: 3 }]
    expect(summarize({ ...report, plan: result, results, quotas: {} }, 'report.md')).toContain(
      'acme-web-2  done, 3 turns (then review: over the cap: rule #1 units is 3)',
    )
    expect(result.skipped.map((s) => [s.item.key, s.reason])).toEqual([
      ['acme/app#3', 'over the cap: rule #1 units is 3'],
      ['acme/api#5', 'over the cap: night.units is 4'],
    ])
  })

  it('counts only units routed to a provider against the caps', () => {
    const yaml = `
night: { start: "01:00", end: "07:00", units: 1 }
providers: [claude: {}, codex: {}]
sources: { github: { repos: [acme/api] } }
queue:
  - { skill: implement, provider: [codex], where: { type: issue } }
  - { skill: fix-ci, where: { checks: failing } }
`
    const issue = fakeItem({
      source: 'github',
      key: 'acme/api#1',
      type: 'issue',
      fields: { repo: 'acme/api' },
    })
    const items = [issue, githubPr(2, { checks: 'failing' })]
    const result = plan(yaml, items, { claude: week(0.1), codex: week(0.99) })
    expect(result.units.map((u) => [u.unit.id, u.provider])).toEqual([
      ['acme-api-1', undefined],
      ['acme-api-2', 'claude'],
    ])
    expect(result.skipped).toEqual([])
  })
})

describe('branch', () => {
  it('renders the key in its own case and the title as a short slug', () => {
    const item = {
      key: 'ABC-123',
      title: 'Fix: the Login page (again) on Safari & Firefox, finally!',
    }
    expect(renderBranch('night/{key}', { ...item, key: 'acme/api#12' })).toBe('night/acme-api-12')
    expect(renderBranch('feat/{key}-{title}', item)).toBe(
      'feat/ABC-123-fix-the-login-page-again-on-safari-firef',
    )
  })

  it('rejects templates that cannot make a branch name', () => {
    expect(templateProblem('night/{key}')).toBeUndefined()
    expect(templateProblem('night/{title}')).toBe('must contain {key}')
    expect(templateProblem('night/{key}/{user}')).toBe('unknown placeholder {user}')
    expect(templateProblem('night..{key}')).toMatch(/invalid branch name/)
    expect(templateProblem('{key}.lock')).toMatch(/invalid branch name/)
    expect(() =>
      parseConfig(
        'providers: [claude: {}]\nsources: { github: { repos: [a/b] } }\nbranch: x y {key}',
      ),
    ).toThrow('branch: renders an invalid branch name')
  })

  it('takes the rule template, then the repo, then the global one', () => {
    const yaml = `
providers: [claude: {}]
sources: { github: { repos: [acme/*] } }
branch: bot/{key}
repos: { acme/api: { branch: 'feat/{key}-{title}' } }
queue:
  - { skill: fix-ci, where: { checks: failing }, branch: 'fix/{key}' }
  - { skill: review, where: { review_requested: true } }
  - { skill: implement, where: { type: issue } }
`
    const items = [
      githubPr(1, { checks: 'failing' }),
      githubPr(2, { review_requested: true }),
      fakeItem({ ...issue, key: 'acme/web#5', fields: { repo: 'acme/web' } }),
    ]
    expect(plan(yaml, items, {}).units.map((u) => u.unit.branch)).toEqual([
      'fix/acme-api-1',
      'feat/acme-api-2-pr-2',
      'bot/acme-web-5',
    ])
  })

  it('skips a feature whose night-shift PR waits for review, whatever item links it', () => {
    const ours = githubPr(9, { checks: 'failing', ours: true })
    const pr = { ...(ours.linkedPrs[0] as PrRef), ours: true }
    const task = asanaTask(4, {}, { linkedPrs: [pr] })
    const yaml =
      'providers: [claude: {}]\nsources: { github: { repos: [acme/*] }, asana: { workspace: "1" } }\nqueue: [{ skill: fix-ci }]'
    const result = plan(yaml, [{ ...ours, linkedPrs: [pr] }, task], {})
    expect(result.units).toEqual([])
    expect(result.skipped.map((s) => s.reason)).toEqual([
      'waiting for review: night-shift PR https://github.com/acme/api/pull/9 is open',
      'waiting for review: night-shift PR https://github.com/acme/api/pull/9 is open',
    ])
  })

  it('holds a PR night-shift pushed onto while its head is still the one the push left', () => {
    const yaml = `
providers: [claude: {}]
sources: { github: { repos: [acme/*] } }
queue: [{ skill: fix-ci, deliver: push }]`
    const at = (head: string, updated: string, n = 1) => {
      const item = githubPr(n, { updated })
      return { ...item, linkedPrs: [{ ...(item.linkedPrs[0] as PrRef), head }] }
    }
    const first = plan(yaml, [at('abc1234', '2026-01-01T00:00:00Z')], {})
    const outcome = { kind: 'pushed', branch: 'feature-1', commits: 1, text: '', head: 'def5678' }
    const results = [{ planned: first.units[0], status: 'done', outcome }]
    const attempts = recordAttempts({}, { runId: 'r1', plan: first, results } as NightReport)
    expect(attempts['github:acme/api#1']?.pushed).toBe('def5678')

    const pushedAt = '2026-01-02T00:00:00Z'
    const held = plan(yaml, [at('def5678', pushedAt), at('def5678', pushedAt, 2)], {}, {}, attempts)
    expect(held.units.map(({ unit }) => unit.id)).toEqual(['acme-api-2'])
    expect(held.skipped.map((s) => s.reason)).toEqual([
      'waiting for review: night-shift pushed onto https://github.com/acme/api/pull/1',
    ])
    const movedOn = plan(yaml, [at('0a1b2c3', '2026-01-03T00:00:00Z')], {}, {}, attempts)
    expect(movedOn.units).toHaveLength(1)
  })

  it('takes up a night-shift PR only for a rule that names ours, and bases the unit on it', () => {
    const ours = githubPr(9, { ours: true, unresolved_threads: 1, my_unresolved_threads: 1 })
    const pr = { ...(ours.linkedPrs[0] as PrRef), branch: 'night/acme-api-5', ours: true }
    const linked = { ...issue, linkedPrs: [pr] }
    const yaml = `
providers: [claude: {}]
sources: { github: { repos: [acme/*] } }
queue:
  - { skill: implement, where: { type: issue } }
  - { skill: address-review, where: { type: pr, unresolved_threads: { gt: 0 } } }
  - { skill: address-review, where: { type: pr, ours: true, unresolved_threads: { gt: 0 } } }`
    const result = plan(yaml, [linked, { ...ours, linkedPrs: [pr] }], {})
    expect(rows(result)).toEqual([['acme-api-9', 3, 'address-review', 'claude', 'draft_pr']])
    expect(result.units[0]?.unit).toMatchObject({
      base: 'night/acme-api-5',
      branch: 'night/acme-api-9',
      foreign: false,
    })
    expect(result.units[0]?.unit.items.map((i) => i.key)).toEqual(['acme/api#9', 'acme/api#5'])
  })

  it('loops on the draft PR stacked on a night-shift PR it takes up', () => {
    const ours = githubPr(9, { ours: true, unresolved_threads: 1, my_unresolved_threads: 1 })
    const pr = { ...(ours.linkedPrs[0] as PrRef), branch: 'night/acme-api-5', ours: true }
    const yaml = `
providers: [claude: {}]
sources: { github: { repos: [acme/*] } }
queue:
  - skill: address-review
    where: { type: pr, ours: true }
    then: { loop: [review, address-review], until: { verdict: approve }, max: 2 }`
    const result = plan(yaml, [{ ...ours, linkedPrs: [pr] }], {})
    expect(result.units.map(({ unit, loop }) => [unit.id, unit.base, loop?.host])).toEqual([
      ['acme-api-9', 'night/acme-api-5', undefined],
      ['acme-api-9-review-1', 'night/acme-api-5', 'acme-api-9'],
      ['acme-api-9-address-review-1', 'night/acme-api-5', 'acme-api-9'],
      ['acme-api-9-review-2', 'night/acme-api-5', 'acme-api-9'],
      ['acme-api-9-address-review-2', 'night/acme-api-5', 'acme-api-9'],
    ])
  })

  it('addresses the threads you started on a night-shift PR by default, not anyone else', () => {
    const yaml = 'providers: [claude: {}]\nsources: { github: { repos: [acme/*] } }'
    const ours = (n: number, mine: number) => {
      const pr = githubPr(n, { ours: true, unresolved_threads: 2, my_unresolved_threads: mine })
      return { ...pr, linkedPrs: [{ ...(pr.linkedPrs[0] as PrRef), ours: true }] }
    }
    const result = plan(yaml, [ours(1, 1), ours(2, 0)], {})
    expect(rows(result)).toEqual([['acme-api-1', 3, 'address-review', 'claude', 'draft_pr']])
    expect(result.skipped.map((s) => s.reason)).toEqual([
      'waiting for review: night-shift PR https://github.com/acme/api/pull/2 is open; closest #3 address-review: my_unresolved_threads is 0, wants not 0',
    ])
  })

  it('skips every item of a feature when one of them is skipped, and says why', () => {
    const pr = githubPr(1, { checks: 'failing' })
    const task = asanaTask(7, {}, { linkedPrs: pr.linkedPrs })
    const yaml =
      'providers: [claude: {}]\nsources: { github: { repos: [acme/*] }, asana: { workspace: "1" } }\nqueue: [{ skill: fix-ci, where: { type: [pr, task] } }]'
    const result = planNight({
      config: parseConfig(yaml),
      items: [pr, task, issue],
      allowances: {},
      skills: { builtin: builtinSkills },
      skips: { 'asana:T-7': { reason: 'blocked on design' }, 'linear:acme/api#1': {} },
    })
    expect(result.units).toEqual([])
    expect(result.skipped.map((s) => [s.item.key, s.reason])).toEqual([
      ['acme/api#5', expect.stringContaining('matched no rule')],
      ['acme/api#1', 'skipped with nightshift skip asana:T-7: blocked on design'],
      ['T-7', 'skipped with nightshift skip asana:T-7: blocked on design'],
    ])
  })
})

describe('attempts', () => {
  const yaml =
    'providers: [claude: {}]\nsources: { github: { repos: [acme/*] }, asana: { workspace: "1" } }\nqueue: [{ skill: fix-ci }]'
  const at = '2026-01-01T00:00:00Z'

  it('skips a unit none of whose items changed since a finished attempt', () => {
    const first = plan(yaml, [githubPr(1, { updated: at }), githubPr(2, { updated: at })], {})
    const [done, stopped] = first.units
    const report = {
      runId: 'r1',
      plan: first,
      results: [
        { planned: done, status: 'done' },
        { planned: stopped, status: 'stopped: quota' },
      ],
    } as NightReport
    const attempts = recordAttempts({}, report)
    expect(attempts).toEqual({
      'github:acme/api#1': { runId: 'r1', skill: 'fix-ci', updated: at },
      'github:acme/api#2': { runId: 'r1', skill: 'fix-ci', updated: at, failed: 1 },
    })

    const later = '2026-01-02T00:00:00Z'
    const items = [
      githubPr(1, { updated: at }),
      githubPr(2, { updated: at }),
      githubPr(3, { updated: at }),
    ]
    const again = plan(yaml, items, {}, {}, attempts)
    expect(again.units.map((u) => u.unit.id)).toEqual(['acme-api-2', 'acme-api-3'])
    expect(again.skipped.map((s) => [s.item.key, s.reason])).toEqual([
      ['acme/api#1', 'unchanged since run r1'],
    ])
    const changed = plan(yaml, [githubPr(1, { updated: later })], {}, {}, attempts)
    expect(changed.units.map((u) => u.unit.id)).toEqual(['acme-api-1'])
  })

  it('runs a unit when any of its items changed, or has no updated time', () => {
    const pr = githubPr(1, { updated: at })
    const task = asanaTask(4, { updated: at }, { linkedPrs: pr.linkedPrs })
    const attempts = {
      'github:acme/api#1': { runId: 'r1', skill: 'fix-ci', updated: at },
      'asana:T-4': { runId: 'r1', skill: 'fix-ci', updated: '2025-12-31T00:00:00Z' },
    }
    expect(plan(yaml, [pr, task], {}, {}, attempts).units).toHaveLength(1)
    const bare = githubPr(1)
    const recorded = { 'github:acme/api#1': { runId: 'r1', skill: 'fix-ci', updated: at } }
    expect(plan(yaml, [bare], {}, {}, recorded).units).toHaveLength(1)
  })

  it('runs an unchanged item again when it matches a different skill', () => {
    const recorded = { 'github:acme/api#1': { runId: 'r1', skill: 'address-review', updated: at } }
    expect(plan(yaml, [githubPr(1, { updated: at })], {}, {}, recorded).units).toHaveLength(1)
  })

  it('retries a unit whose commits were left unpublished, counting a failure', () => {
    const first = plan(yaml, [githubPr(1, { updated: at })], {})
    const outcome = {
      kind: 'none',
      reason: '2 commits but no PR body, not pushed',
      unpublished: true,
    }
    const results = [{ planned: first.units[0], status: 'done', outcome }]
    expect(recordAttempts({}, { runId: 'r1', plan: first, results } as NightReport)).toEqual({
      'github:acme/api#1': { runId: 'r1', skill: 'fix-ci', updated: at, failed: 1 },
    })
  })

  it('loads a corrupt attempts file as empty and saves through a rename', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'attempts-'))
    const path = join(dir, 'attempts.json')
    await writeFile(path, '{"github:acme/api#1": {"runId"')
    expect(await loadAttempts(path)).toEqual({})
    const recorded = { 'github:acme/api#1': { runId: 'r1', skill: 'fix-ci', updated: at } }
    await saveAttempts(path, recorded)
    expect(await loadAttempts(path)).toEqual(recorded)
    expect(await readdir(dir)).toEqual(['attempts.json'])
  })

  it('records a chain once, only when every unit finished', () => {
    const chain = yaml.replace('{ skill: fix-ci }', '{ skill: plan, then: [implement, review] }')
    const first = plan(chain, [githubPr(1, { updated: at })], {})
    const [head, implement, review] = first.units.map((planned) => ({ planned }))
    const outcomes = {
      review: { kind: 'report', text: 'r' },
      pr: { kind: 'pr', url: 'u', commits: 1 },
    }
    const record = (...results: object[]) =>
      recordAttempts({}, { runId: 'r1', plan: first, results } as NightReport)
    const planned = { ...head, status: 'done', outcome: outcomes.review }
    const opened = { ...implement, status: 'done', outcome: outcomes.pr }

    expect(record(planned, { ...implement, status: 'failed' })).toEqual({
      'github:acme/api#1': { runId: 'r1', skill: 'plan', updated: at, failed: 1 },
    })
    expect(record({ ...head, status: 'prepared' })).toEqual({})
    expect(record(planned, opened)).toEqual({})
    const gaveUp = { ...implement, status: 'done', outcome: { kind: 'none', reason: 'no commits' } }
    const attempts = record(planned, gaveUp, { ...review, status: 'skipped' })
    expect(attempts).toEqual({ 'github:acme/api#1': { runId: 'r1', skill: 'plan', updated: at } })
    const reviewed = { ...review, status: 'done', outcome: outcomes.review }
    expect(record(planned, opened, reviewed)).toEqual(attempts)

    const again = plan(chain, [githubPr(1, { updated: at })], {}, {}, attempts)
    expect(again.units).toEqual([])
    expect(again.skipped.map((s) => s.reason)).toEqual(['unchanged since run r1'])
  })

  it("counts a loop through its host's draft PR, whatever its rounds did", () => {
    const chain = yaml.replace(
      '{ skill: fix-ci }',
      '{ skill: implement, then: { loop: [review, address-review], until: { verdict: approve }, max: 2 } }',
    )
    const first = plan(chain, [githubPr(1, { updated: at })], {})
    const [host, review] = first.units.map((planned) => ({ planned }))
    const record = (...results: object[]) =>
      recordAttempts({}, { runId: 'r1', plan: first, results } as NightReport)
    const failedRound = { ...review, status: 'failed' }

    expect(
      record(
        { ...host, status: 'done', outcome: { kind: 'pr', url: 'u', commits: 1 } },
        failedRound,
      ),
    ).toEqual({ 'github:acme/api#1': { runId: 'r1', skill: 'implement', updated: at } })
    const unpublished = { kind: 'none', reason: 'push failed', unpublished: true }
    expect(record({ ...host, status: 'done', outcome: unpublished }, failedRound)).toEqual({
      'github:acme/api#1': { runId: 'r1', skill: 'implement', updated: at, failed: 1 },
    })
    const interrupted = { kind: 'none', reason: 'interrupted', unpublished: true }
    expect(record({ ...host, status: 'done', outcome: interrupted }, failedRound)).toEqual({})
  })

  it('gives up on an item after three chains that did not finish, until it changes', () => {
    const chain = yaml.replace('{ skill: fix-ci }', '{ skill: plan, then: implement }')
    const report = { kind: 'report', text: 'r' }
    let attempts: Attempts = {}
    for (const runId of ['r1', 'r2', 'r3']) {
      const night = plan(chain, [githubPr(1, { updated: at })], {}, {}, attempts)
      expect(night.units).toHaveLength(2)
      const [head, implement] = night.units
      const results = [
        { planned: head, status: 'done', outcome: report },
        { planned: implement, status: 'failed' },
      ]
      attempts = recordAttempts(attempts, { runId, plan: night, results } as NightReport)
    }
    expect(attempts).toEqual({
      'github:acme/api#1': { runId: 'r3', skill: 'plan', updated: at, failed: 3 },
    })
    const gaveUp = plan(chain, [githubPr(1, { updated: at })], {}, {}, attempts)
    expect(gaveUp.units).toEqual([])
    expect(gaveUp.skipped.map((s) => s.reason)).toEqual([
      'gave up after 3 attempts; waiting for the item to change',
    ])
    const later = '2026-01-02T00:00:00Z'
    expect(plan(chain, [githubPr(1, { updated: later })], {}, {}, attempts).units).toHaveLength(2)
    const other = chain.replace('skill: plan', 'skill: review')
    expect(plan(other, [githubPr(1, { updated: at })], {}, {}, attempts).units).toHaveLength(2)
  })

  it('clears failures on a finished attempt and ignores units that did not run', () => {
    const first = plan(yaml, [githubPr(1, { updated: at })], {})
    const failed = { 'github:acme/api#1': { runId: 'r0', skill: 'fix-ci', updated: at, failed: 2 } }
    const recorded = (result: object) =>
      recordAttempts(failed, {
        runId: 'r1',
        plan: first,
        results: [{ planned: first.units[0], ...result }],
      } as NightReport)

    expect(recorded({ status: 'done', outcome: { kind: 'pr', url: 'u', commits: 1 } })).toEqual({
      'github:acme/api#1': { runId: 'r1', skill: 'fix-ci', updated: at },
    })
    expect(recorded({ status: 'error', reason: 'clone failed' })['github:acme/api#1']?.failed).toBe(
      3,
    )
    for (const status of ['skipped', 'prepared', 'stopped: aborted'])
      expect(recorded({ status })).toEqual(failed)
  })
})

describe('plan --json', () => {
  it('prints the plan and warnings, without raw source payloads', () => {
    const result = plan(example, [issue, githubPr(3)], { claude: week(0.36), codex: null })
    const json = JSON.parse(planJson(result, ['source asana: offline']))
    expect(Object.keys(json)).toEqual([
      'queue',
      'defaultQueue',
      'units',
      'skipped',
      'allowances',
      'warnings',
    ])
    expect(json.warnings).toEqual(['source asana: offline'])
    expect(json.units[0].unit).toMatchObject({ id: 'acme-api-5', skill: 'implement' })
    expect(json.units[0].unit.items[0]).not.toHaveProperty('raw')
    expect(json.allowances.claude).toMatchObject({ kind: 'quota', used: 0.36 })
  })
})
