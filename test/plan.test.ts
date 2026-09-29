import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import { describeAllowance, formatPlan, planJson } from '../src/cli/format.js'
import { parseConfig } from '../src/config/load.js'
import { renderBranch, templateProblem } from '../src/core/branch.js'
import { type Allowance, allowance } from '../src/core/budget.js'
import { planNight } from '../src/core/foreman.js'
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
) {
  const config = parseConfig(yaml)
  const allowances: Record<string, Allowance> = {}
  for (const p of config.providers)
    allowances[p.id] = allowance(p.budget, quotas[p.id] ?? null, now)
  return planNight({ config, items, allowances, skills: { builtin: builtinSkills, ...skills } })
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
    expect(result.queue.map((r) => r.skill)).toEqual(['fix-ci', 'address-review', 'review'])
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

  it('gathers every instruction file for the unit in prompt order', () => {
    const [first] = plan(example, [githubPr(1, { checks: 'failing' })], {}).units
    expect(first?.unit.instructions).toEqual(['notes/me.md', 'notes/acme-api.md'])
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
    expect(result.skipped.map((s) => [s.item.key, s.reason])).toEqual([
      ['acme/web#2', 'then review: over the cap: rule #1 units is 3'],
      ['acme/app#3', 'over the cap: rule #1 units is 3'],
      ['acme/api#5', 'over the cap: night.units is 4'],
    ])
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
    const ours = githubPr(9, { checks: 'failing' })
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
