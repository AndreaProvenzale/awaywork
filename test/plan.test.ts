import { mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import {
  describeAllowance,
  formatPlan,
  formatWhy,
  listedUnits,
  namedItems,
  planJson,
  queueLines,
} from '../src/cli/format.js'
import { finishedSince, probeAndPlan, ruleNumber } from '../src/cli/plan.js'
import type { Step } from '../src/cli/triage.js'
import { parseConfig } from '../src/config/load.js'
import {
  type Attempts,
  loadAttempts,
  recordAttempts,
  saveAttempts,
  unchangedSince,
} from '../src/core/attempts.js'
import { renderBranch, templateProblem } from '../src/core/branch.js'
import { type Allowance, allowance } from '../src/core/budget.js'
import { approveReply, markComment, planComment } from '../src/core/footer.js'
import { needsYou, planRun } from '../src/core/foreman.js'
import type { RunReport } from '../src/core/report.js'
import { builtinSkills, type SkillCatalog } from '../src/core/skills.js'
import type { Item, PrRef, Quota, Rule } from '../src/core/types.js'
import { asanaTask, fakeItem, githubPr } from './fakes/items.js'

const example = await readFile(new URL('fixtures/example.yml', import.meta.url), 'utf8')
const now = new Date(2026, 0, 1, 1).getTime()
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
  time = now,
) {
  const config = parseConfig(yaml)
  const allowances: Record<string, Allowance> = {}
  for (const p of config.providers)
    allowances[p.id] = allowance(p.budget, quotas[p.id] ?? null, now, config.windows)
  return planRun({
    config,
    items,
    allowances,
    skills: { builtin: builtinSkills, ...skills },
    attempts,
    now: time,
  })
}
const rows = (p: ReturnType<typeof plan>) =>
  p.units.map((u) => [u.unit.id, u.rule + 1, u.unit.skill, u.provider ?? '-', u.unit.deliver])
const why = (p: ReturnType<typeof plan>, name: string) => {
  const [item] = namedItems(p, name)
  return item && formatWhy(p, item)
}

const issue = fakeItem({
  source: 'github',
  key: 'acme/api#5',
  type: 'issue',
  title: 'Add rate limits',
  fields: { repo: 'acme/api', label: ['awaywork'] },
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
      ['acme-api-1', 1, 'fix', 'claude', 'draft_pr'],
      ['acme-api-5', 2, 'implement', 'claude', 'draft_pr'],
      ['acme-api-2', 3, 'review', 'claude', 'report'],
    ])
    expect(result.units[0]?.unit).toMatchObject({
      base: 'feature-1',
      foreign: false,
      branch: 'away/acme-api-1',
    })
    expect(result.units[2]?.unit).toMatchObject({ base: 'feature-2', foreign: true })
    expect(formatPlan(result)).toMatchInlineSnapshot(`
      "Providers
        provider  window     used  ceiling  set by   resets in  session / stop at
        claude    seven_day  36%   51%      per_run  3 runs     2% / 90%
          other limits: reserve cap 90%, pacing 54%
        codex     fallback
          4 units, 60 turns each (no quota reading)

      Units 3
           item   rule  skill                 provider  deliver   title
        1  api#1  #1    fix (built-in)        claude    draft_pr  PR 1
           + T-7: same feature, matched #4
        2  api#5  #2    implement (built-in)  claude    draft_pr  Add rate limits
        3  api#2  #3    review (built-in)     claude    report    PR 2

      Needs you 1
        T-8  no repo: no linked PR or repo field
             Task 8

      Skipped 1: 1 no_rule

      awaywork plan --skipped [kind]  lists them
      awaywork plan --why <key>       says why an item is planned or not"
    `)
    expect(formatPlan(result, [], true)).toBe(formatPlan(result))
    expect(result.skipped.map((s) => [s.kind, needsYou[s.kind]])).toEqual([
      ['no_rule', false],
      ['no_repo', true],
    ])
  })

  it('plans only a repo glob or a rule, under the full run caps', () => {
    const config = parseConfig(`
limits: { units: 2, units_per_repo: 1 }
providers: [claude: {}]
sources: { github: { repos: [acme/*] } }
queue:
  - { skill: fix, where: { checks: failing } }
  - { skill: implement, where: { type: issue } }
`)
    const inRepo = (repo: string, n: number) =>
      fakeItem({ source: 'github', key: `${repo}#${n}`, type: 'issue', fields: { repo } })
    const items = [
      githubPr(1, { checks: 'failing' }),
      githubPr(2, { checks: 'failing' }),
      inRepo('acme/web', 3),
      inRepo('acme/ops', 4),
      inRepo('acme/ops', 5),
    ]
    const allowances = Object.fromEntries(
      config.providers.map((p) => [p.id, allowance(p.budget, week(0.1), now, config.windows)]),
    )
    const ids = (only: { repo?: string; rule?: number }) =>
      planRun({
        config,
        items,
        allowances,
        skills: { builtin: builtinSkills },
        now,
        only,
      }).units.map((u) => u.unit.id)
    expect(ids({})).toEqual(['acme-api-1', 'acme-web-3'])
    expect(ids({ repo: 'ACME/ops' })).toEqual(['acme-ops-4'])
    expect(ids({ rule: 2 })).toEqual(['acme-web-3', 'acme-ops-4'])
    expect(ids({ repo: 'acme/*', rule: 1 })).toEqual(['acme-api-1'])
    expect(ids({ repo: '' })).toEqual([])
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
    expect(result.queue.map((r) => r.skill)).toEqual(['fix', 'fix', 'fix', 'review'])
    expect(rows(result).map((r) => [r[0], r[2]])).toEqual([
      ['acme-api-3', 'fix'],
      ['acme-api-2', 'fix'],
      ['acme-api-1', 'review'],
    ])
    expect(result.skipped.map((s) => s.item.key)).toEqual(['acme/api#4'])
  })

  it('names the failing comparison of the closest rule', () => {
    const yaml = `
providers: [claude: {}]
sources: { github: { repos: [acme/api] } }
queue: [{ skill: fix, where: { unresolved_threads: { gte: 2, lt: 5 } } }]`
    const result = plan(yaml, [githubPr(1, { unresolved_threads: 1 })], { claude: week(0.1) })
    expect(result.skipped.map((s) => [s.kind, s.reason])).toEqual([
      ['no_rule', 'matched no rule; closest #1 fix: unresolved_threads is 1, wants >= 2 and < 5'],
    ])
    expect(queueLines(result)).toContain('  #1  fix  unresolved_threads>=2 unresolved_threads<5')
  })

  it('names the failing relative date of the closest rule', () => {
    const yaml = `
providers: [claude: {}]
sources: { github: { repos: [acme/api] } }
queue: [{ skill: fix, where: { updated: { older_than: 3d } } }]`
    const now = new Date().toISOString()
    const result = plan(yaml, [githubPr(1, { updated: now })], { claude: week(0.1) })
    expect(result.skipped.map((s) => s.reason)).toEqual([
      `matched no rule; closest #1 fix: updated is ${now}, wants older than 3d`,
    ])
    expect(queueLines(result)).toContain('  #1  fix  updated:older_than=3d')
  })

  it('names the failed text match', () => {
    const yaml = `
providers: [claude: {}]
sources: { github: { repos: [acme/api] } }
queue: [{ skill: fix, where: { description: { matches: '^\\[bug\\]' } } }]`
    const item = { ...githubPr(1, {}), description: 'Line one\nLine two' }
    const result = plan(yaml, [item], { claude: week(0.1) })
    expect(result.skipped.map((s) => s.reason)).toEqual([
      'matched no rule; closest #1 fix: description wants matches /^\\[bug\\]/i',
    ])
  })

  it('names the failing entries of any', () => {
    const yaml = `
providers: [claude: {}]
sources: { github: { repos: [acme/api] } }
queue: [{ skill: fix, where: { any: [{ checks: failing }, { title: { matches: zzz } }] } }]`
    const result = plan(yaml, [githubPr(1, {})], { claude: week(0.1) })
    const reason = result.skipped[0]?.reason
    expect(reason).toContain('none of any matched')
    expect(reason).toContain('checks is passing, wants failing')
    expect(reason).toContain('wants matches /zzz/i')
  })

  it('routes past a provider at its ceiling and caps fallback units', () => {
    const yaml = `
budget: { fallback: { units: 1, turns: 30 } }
providers: [claude: {}, codex: {}]
sources: { github: { repos: [acme/api] } }
queue:
  - { skill: fix, where: { checks: failing } }
  - { skill: fix, provider: [codex], where: { unresolved_threads: { not: 0 } } }
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
      'codex used its 1 fallback unit',
    ])
    expect(formatPlan(result)).toContain(
      'provider: claude at its ceiling (95% of 90%); codex used its 1 fallback unit; none left',
    )
  })

  it('routes between claude and codex on their own windows', () => {
    const yaml = `
providers: [claude: {}, codex: { budget: { per_run: 5% } }]
sources: { github: { repos: [acme/api] } }
queue:
  - { skill: fix, where: { checks: failing } }
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
        '  codex     30d        4%    6.9%     pacing  30 runs    -',
        '    other limits: per_run 9%, reserve cap 90%',
      ].join('\n'),
    )
    expect(describeAllowance('codex', result.allowances.codex as Allowance)).toBe(
      '30d 4% used, ceiling 6.9% set by pacing (per_run 9%, reserve cap 90%; resets in 30 runs)',
    )

    const full = plan(yaml, items, { claude: week(0.95), codex: month })
    expect(rows(full).map((r) => r[3])).toEqual(['codex', 'codex'])
    expect(full.units[0]?.passed).toEqual(['claude at its ceiling (95% of 90%)'])
  })

  it('resolves skills and delivery: a skill commits unless it reports, whatever the rule says', () => {
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
      ['plan', 'builtin', 'report'],
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
  - skill: fix
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

  it('says why a quota when fails, on the rule only', () => {
    const yaml = (rule: string) => `
providers: [claude: {}]
sources: { github: { repos: [acme/api] } }
queue:
  - skill: fix
    where: { checks: failing }
    ${rule}
    then: review
`
    const items = [githubPr(1, { checks: 'failing' })]
    const units = (rule: string, quota: Quota | null) =>
      plan(yaml(rule), items, { claude: quota }).units.map((u) => u.quotaUnmet)
    const unmet = "doesn't hold on the probe"
    expect(units('when: { runs_until_reset: 1 }', week(0.36))).toEqual([unmet, undefined])
    expect(units('when: { runs_until_reset: 3 }', week(0.36))).toEqual([undefined, undefined])
    expect(units('when: { headroom: 10% }', week(0.36))).toEqual([undefined, undefined])
    expect(units('when: { headroom: 20% }', week(0.36))).toEqual([unmet, undefined])
    expect(units('when: { headroom: 1% }', null)[0]).toBe('no quota reading')
    expect(units('when: { headroom: 1% }', week(0.95))).toEqual([undefined, undefined])
  })

  it("chains steps in one clone, each with the rule's settings unless it sets its own", () => {
    const yaml = `
providers: [claude, codex]
sources: { github: { repos: [acme/api] } }
mcp: { sentry: { command: sentry-mcp } }
queue:
  - skill: plan
    where: { type: issue }
    model: { claude: opus }
    mcp: [sentry]
    skills: [our-api]
    instructions: notes/rule.md
    with: { depth: 2 }
    then:
      - { skill: implement, model: { claude: sonnet }, instructions: notes/impl.md }
      - { skill: review, provider: codex, mcp: [], skills: [], instructions: [] }
  - { skill: fix, where: { checks: failing }, then: review }
`
    const items = [issue, githubPr(3, { checks: 'failing' })]
    const result = plan(yaml, items, { claude: week(0.1), codex: week(0.1) })
    expect(
      result.units.map(({ unit, provider, chain }) => [
        unit.id,
        provider,
        unit.deliver,
        unit.base,
        unit.branch,
        chain,
      ]),
    ).toEqual([
      ['acme-api-5', 'claude', 'report', '', 'away/acme-api-5', undefined],
      ['acme-api-5-implement', 'claude', 'draft_pr', '', 'away/acme-api-5', 'acme-api-5'],
      ['acme-api-5-review', 'codex', 'report', '', 'away/acme-api-5', 'acme-api-5'],
      ['acme-api-3', 'claude', 'draft_pr', 'feature-3', 'away/acme-api-3', undefined],
      ['acme-api-3-review', 'claude', 'report', 'feature-3', 'away/acme-api-3', 'acme-api-3'],
    ])
    expect(
      result.units.slice(0, 3).map(({ unit }) => [unit.rule.model, unit.rule.mcp, unit.rule.with]),
    ).toEqual([
      [{ claude: 'opus' }, ['sentry'], { depth: 2 }],
      [{ claude: 'sonnet' }, ['sentry'], undefined],
      [{ claude: 'opus' }, [], undefined],
    ])
    expect(result.units.slice(0, 3).map(({ unit }) => [unit.instructions, unit.skills])).toEqual([
      [['notes/rule.md'], ['our-api']],
      [['notes/impl.md'], ['our-api']],
      [[], []],
    ])
    const text = formatPlan(result)
    expect(queueLines(result).join('\n')).toContain(
      '#1  plan  type=issue model=claude:opus then=implement,review',
    )
    expect(text).toContain(
      [
        '  1  api#5  #1    plan (built-in)  claude    draft_pr  Add rate limits',
        '     then implement (built-in) on claude',
        '     then review (built-in) on codex',
      ].join('\n'),
    )
  })

  it('plans every round of a loop, routing each, so a loop holds fallback units up to max', () => {
    const yaml = `
budget: { fallback: { units: 6, turns: 30 } }
providers: [claude]
sources: { github: { repos: [acme/api] } }
queue:
  - skill: fix
    where: { type: pr }
    then:
      - { loop: [review, fix], until: { verdict: [approve, comments] }, max: 3 }
      - { skill: plan, when: { verdict: changes } }
`
    const result = plan(yaml, [githubPr(1), githubPr(2)], {})
    expect(
      result.units.map(({ unit, provider, loop }) => [
        unit.id,
        provider ?? '-',
        loop && `${loop.round}.${loop.step}`,
      ]),
    ).toEqual([
      ['acme-api-1', 'claude', undefined],
      ['acme-api-1-review-1', 'claude', '1.0'],
      ['acme-api-1-fix-1', 'claude', '1.1'],
      ['acme-api-1-review-2', 'claude', '2.0'],
      ['acme-api-1-fix-2', 'claude', '2.1'],
      ['acme-api-1-review-3', 'claude', '3.0'],
      ['acme-api-1-fix-3', '-', '3.1'],
      ['acme-api-1-plan', '-', undefined],
      ['acme-api-2', '-', undefined],
      ['acme-api-2-review-1', '-', '1.0'],
      ['acme-api-2-fix-1', '-', '1.1'],
      ['acme-api-2-review-2', '-', '2.0'],
      ['acme-api-2-fix-2', '-', '2.1'],
      ['acme-api-2-review-3', '-', '3.0'],
      ['acme-api-2-fix-3', '-', '3.1'],
      ['acme-api-2-plan', '-', undefined],
    ])
    const text = formatPlan(result)
    expect(queueLines(result).join('\n')).toContain('then=loop(review,fix),plan')
    expect(text).toContain(
      [
        '     then loop review ⇄ fix until verdict approve or comments, at most 3 rounds',
        '       review (built-in) on claude',
        '       fix (built-in) on claude',
        '     then plan (built-in) on no provider left (claude used its 6 fallback units), when verdict changes',
      ].join('\n'),
    )
    expect(text).not.toContain('acme-api-1-review-2')
    const once = plan(yaml.replace('max: 3', 'max: 1'), [githubPr(1)], {})
    expect(formatPlan(once)).toContain('at most 1 round\n')
  })

  it('counts a chain once against the caps, and leaves one over a cap out whole', () => {
    const yaml = `
limits: { units: 3 }
budget: { fallback: { units: 20, turns: 30 } }
providers: [claude]
sources: { github: { repos: [acme/api] } }
queue:
  - skill: implement
    where: { type: pr }
    units: 2
    then: { loop: [review, fix], until: { verdict: approve }, max: 3 }
  - { skill: fix, where: { type: issue } }
`
    const result = plan(yaml, [githubPr(1), githubPr(2), githubPr(3), issue], {})
    expect(listedUnits(result).map((u) => u.unit.id)).toEqual([
      'acme-api-1',
      'acme-api-2',
      'acme-api-5',
    ])
    expect(result.units).toHaveLength(15)
    expect(result.skipped.map((s) => [s.item.key, s.kind, s.reason])).toEqual([
      ['acme/api#3', 'over_cap', 'over the cap: rule #1 units is 2'],
    ])
  })

  it("keeps a chain on someone else's PR foreign, and skips it whole on an invalid branch", () => {
    const yaml = (skill: string, step: string) =>
      `providers: [claude]\nsources: { github: { repos: [acme/api] } }\nqueue: [{ skill: ${skill}, then: ${step} }]`
    const theirs = githubPr(2, { checks: 'failing', mine: false })
    expect(plan(yaml('review', 'plan'), [theirs], {}).units.map((u) => u.unit.foreign)).toEqual([
      true,
      true,
    ])
    const result = plan(yaml('review', 'plan'), [{ ...theirs, key: 'acme/api#2.lock' }], {})
    expect(result.units).toEqual([])
    expect(result.skipped.map((s) => [s.kind, s.reason])).toEqual([
      [
        'invalid_branch',
        'branch template away/{key} renders an invalid name "away/acme-api-2.lock"',
      ],
    ])
  })

  it("refuses a chain that could commit onto someone else's PR or a fork, and reports there", () => {
    const yaml = `
providers: [claude]
sources: { github: { repos: [acme/api] } }
queue:
  - { skill: review, where: { type: pr }, then: { loop: [review, implement], until: { verdict: approve }, max: 2 } }
  - { skill: review, where: { type: issue }, deliver: report, then: [implement] }
`
    const theirs = githubPr(2, { mine: false })
    const forked = githubPr(3)
    const fork = { ...(forked.linkedPrs[0] as PrRef), branch: 'main', head: 'f0f0f0f', fork: true }
    const closing = { ...issue, linkedPrs: [{ ...fork, number: 4, branch: 'patch' }] }
    const result = plan(yaml, [theirs, { ...forked, linkedPrs: [fork] }, closing], {})
    expect(result.skipped.map((s) => [s.item.key, s.kind, s.reason])).toEqual([
      [
        'acme/api#2',
        'refused_delivery',
        "deliver draft_pr: feature-2 is someone else's PR, and implement commits",
      ],
      [
        'acme/api#3',
        'refused_delivery',
        'deliver draft_pr: main is on a fork, and implement commits',
      ],
    ])
    // With deliver: report no step commits, so the chain reports on the fork, at its head.
    expect(result.units.map(({ unit }) => [unit.id, unit.deliver, unit.base, unit.fork])).toEqual([
      ['acme-api-5', 'report', 'patch', { number: 4, head: 'f0f0f0f' }],
      ['acme-api-5-implement', 'report', 'patch', { number: 4, head: 'f0f0f0f' }],
    ])
    expect(why(result, 'acme/api#5')).toMatch(/deliver +report\n +branch +away\/acme-api-5$/)
    const mine = plan(yaml, [githubPr(1)], {})
    expect(mine.units.map(({ unit }) => [unit.id, unit.base])).toContainEqual([
      'acme-api-1-implement-1',
      'feature-1',
    ])
  })

  it("pushes a chain only onto your own PR's branch, the deliver of every step that commits", () => {
    const yaml = `
providers: [claude]
sources: { github: { repos: [acme/api] } }
queue:
  - { skill: fix, where: { type: pr }, deliver: push, then: [review, { loop: [implement], until: { verdict: approve }, max: 2 }] }
  - { skill: implement, where: { type: issue }, deliver: push }
`
    const mine = githubPr(1)
    const theirs = githubPr(2, { mine: false })
    const result = plan(yaml, [mine, theirs, issue], {})
    expect(result.units.map(({ unit }) => [unit.id, unit.deliver, unit.base])).toEqual([
      ['acme-api-1', 'push', 'feature-1'],
      ['acme-api-1-review', 'report', 'feature-1'],
      ['acme-api-1-implement-1', 'push', 'feature-1'],
      ['acme-api-1-implement-2', 'push', 'feature-1'],
    ])
    expect(result.skipped.map((s) => [s.item.key, s.kind, s.reason])).toEqual([
      ['acme/api#2', 'refused_delivery', "deliver push: feature-2 is someone else's PR"],
      ['acme/api#5', 'refused_delivery', 'deliver push: no PR of yours to push onto'],
    ])
    expect(why(result, 'api#1')).toMatch(/deliver +push\n +branch +feature-1$/)
    // A chain that starts with a report still pushes what a later step commits.
    const relayed = plan(yaml.replace('skill: fix,', 'skill: plan,'), [mine], {})
    expect(formatPlan(relayed)).toMatch(/api#1 +#1 +plan \(built-in\) +claude +push +PR 1\n/)
  })

  it('lets a push, draft PR or PR rule take the first linked PR that is yours', () => {
    const theirs = githubPr(2, { mine: false }).linkedPrs[0] as PrRef
    const mine = githubPr(1).linkedPrs[0] as PrRef
    const issue = { ...githubPr(5), linkedPrs: [theirs, mine] }
    const yaml = (deliver: string) =>
      `providers: [claude]\nsources: { github: { repos: [acme/api] } }\nqueue: [{ skill: implement, deliver: ${deliver} }]`
    const pushed = plan(yaml('push'), [issue], {})
    expect(pushed.units.map(({ unit }) => [unit.deliver, unit.base])).toEqual([
      ['push', 'feature-1'],
    ])
    expect(plan(yaml('draft_pr'), [issue], {}).units[0]?.unit.base).toBe('feature-1')
    expect(plan(yaml('pr'), [issue], {}).units[0]?.unit).toMatchObject({
      deliver: 'pr',
      base: 'feature-1',
    })
    expect(plan(yaml('report'), [issue], {}).units[0]?.unit.base).toBe('feature-2')
    const theirs2 = githubPr(3, { mine: false }).linkedPrs[0] as PrRef
    const both = [{ ...githubPr(6), linkedPrs: [theirs, theirs2] }]
    for (const deliver of ['push', 'draft_pr', 'pr']) {
      const none = plan(yaml(deliver), both, {})
      expect(none.units).toEqual([])
      expect(none.skipped.map((s) => s.reason)).toEqual([
        `deliver ${deliver}: feature-2 is someone else's PR`,
      ])
    }
  })

  it('plans a pending_review chain on any PR, every step reporting, and refuses one with no PR to review', () => {
    const yaml = `
providers: [claude]
sources: { github: { repos: [acme/api] } }
queue: [{ skill: plan, deliver: pending_review, then: [review] }]
`
    const fork = { ...githubPr(2, { mine: false, trusted: false }) }
    fork.linkedPrs = [{ ...(fork.linkedPrs[0] as PrRef), fork: true, head: 'abc1234' }]
    const result = plan(yaml, [githubPr(1), fork, issue], {})
    expect(
      result.units.map(({ unit }) => [unit.id, unit.deliver, unit.base, unit.foreign]),
    ).toEqual([
      ['acme-api-1', 'pending_review', 'feature-1', false],
      ['acme-api-1-review', 'pending_review', 'feature-1', false],
      ['acme-api-2', 'pending_review', 'feature-2', true],
      ['acme-api-2-review', 'pending_review', 'feature-2', true],
    ])
    expect(result.skipped.map((s) => [s.item.key, s.kind, s.reason])).toEqual([
      ['acme/api#5', 'refused_delivery', 'deliver pending_review: no pull request to review'],
    ])
    expect(formatPlan(result)).toMatch(
      /api#1 +#1 +plan \(built-in\) +claude +pending_review +PR 1\n/,
    )
    expect(why(result, 'api#2')).toMatch(/deliver +pending_review\n/)
  })

  it('gathers every instruction file for the unit in prompt order', () => {
    const [first] = plan(example, [githubPr(1, { checks: 'failing' })], {}).units
    expect(first?.unit.instructions).toEqual(['notes/me.md', 'notes/acme-api.md'])
  })

  it('skips units past the run, repo and rule caps, naming the cap', () => {
    const yaml = `
limits: { units: 4, units_per_repo: 2 }
providers: [claude: {}]
sources: { github: { repos: [acme/*] } }
queue:
  - { skill: fix, where: { checks: failing }, units: 1 }
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
    expect(result.skipped.map((s) => [s.item.key, s.kind, s.reason])).toEqual([
      ['acme/api#2', 'over_cap', 'over the cap: rule #1 units is 1'],
      ['acme/api#4', 'over_cap', 'over the cap: limits.units_per_repo is 2'],
      ['acme/ops#7', 'over_cap', 'over the cap: limits.units is 4'],
    ])
  })

  it('counts only units routed to a provider against the caps', () => {
    const yaml = `
limits: { units: 1 }
providers: [claude: {}, codex: {}]
sources: { github: { repos: [acme/api] } }
queue:
  - { skill: implement, provider: [codex], where: { type: issue } }
  - { skill: fix, where: { checks: failing } }
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

  it('leaves a provider unavailable here out of the run, without probing it, and says why', async () => {
    const yaml =
      'providers: [codex]\nsources: { tracker: { command: "echo []", fields: [column] } }\n'
    vi.stubEnv('RUNNER_ENVIRONMENT', 'github-hosted')
    try {
      const { plan, warnings } = await probeAndPlan(
        parseConfig(yaml),
        await mkdtemp(join(tmpdir(), 'awaywork-skills-')),
        {
          retry: true,
        },
      )
      expect(plan.allowances).toEqual({})
      expect(warnings).toEqual([
        expect.stringMatching(/^codex unavailable: a GitHub-hosted runner/),
      ])
    } finally {
      vi.unstubAllEnvs()
    }
  })

  it('warns on a GitHub-hosted runner that a window over 6 hours ends early', async () => {
    const skills = await mkdtemp(join(tmpdir(), 'awaywork-skills-'))
    const warned = async (windows: string) => {
      const yaml = `windows: ${windows}\nproviders: [claude]\nsources: { tracker: { command: "echo []", fields: [column] } }\n`
      // No provider, so none is probed.
      const config = { ...parseConfig(yaml), providers: [] }
      const { warnings } = await probeAndPlan(config, skills, { retry: true })
      return warnings.filter((w) => w.startsWith('GitHub-hosted'))
    }
    vi.stubEnv('RUNNER_ENVIRONMENT', 'github-hosted')
    try {
      expect(
        await warned('[{ start: "18:00", end: "07:00" }, { start: "01:00", end: "07:00" }]'),
      ).toEqual([
        'GitHub-hosted runners end a job at 6 hours, so a run stops 5h40 after it starts, before 18:00-07:00 ends',
      ])
      expect(await warned('[{ start: "01:00", end: "07:00" }]')).toEqual([])
      vi.stubEnv('RUNNER_ENVIRONMENT', 'self-hosted')
      expect(await warned('[{ start: "18:00", end: "07:00" }]')).toEqual([])
    } finally {
      vi.unstubAllEnvs()
    }
  })

  it('reports each source and provider as it loads, for the loader', async () => {
    const yaml =
      'providers: [codex]\nsources: { tracker: { command: "echo []" }, chores: { command: "exit 3" } }\n'
    const steps: Step[] = []
    vi.stubEnv('RUNNER_ENVIRONMENT', 'github-hosted')
    try {
      await probeAndPlan(parseConfig(yaml), await mkdtemp(join(tmpdir(), 'awaywork-skills-')), {
        retry: true,
        onProgress: (step) => steps.push(step),
      })
    } finally {
      vi.unstubAllEnvs()
    }
    expect(steps).toEqual([
      { name: 'tracker', state: 'running' },
      { name: 'tracker', state: 'done', detail: '0 items' },
      { name: 'chores', state: 'running' },
      { name: 'chores', state: 'failed', detail: "Command failed with exit code 3: 'exit 3'" },
      {
        name: 'codex quota',
        state: 'failed',
        detail: expect.stringMatching(/^unavailable: a GitHub-hosted runner/),
      },
    ])
  })

  it("masks a failing source's secret in the warnings plan prints", async () => {
    const yaml =
      'providers: [codex]\nsources: { chores: { command: \'echo "auth failed for $CHORES_TOKEN" >&2; exit 1\', secrets: [CHORES_TOKEN] } }\n'
    vi.stubEnv('RUNNER_ENVIRONMENT', 'github-hosted')
    vi.stubEnv('CHORES_TOKEN', 's3cr3t-value')
    try {
      const { warnings } = await probeAndPlan(
        parseConfig(yaml),
        await mkdtemp(join(tmpdir(), 'awaywork-skills-')),
        { retry: true },
      )
      expect(warnings).toContainEqual(expect.stringMatching(/\nauth failed for \*\*\*$/))
      expect(warnings.join('\n')).not.toContain('s3cr3t-value')
    } finally {
      vi.unstubAllEnvs()
    }
  })
})

describe('branch', () => {
  it('renders the key in its own case and the title as a short slug', () => {
    const item = {
      key: 'ABC-123',
      title: 'Fix: the Login page (again) on Safari & Firefox, finally!',
    }
    expect(renderBranch('away/{key}', { ...item, key: 'acme/api#12' })).toBe('away/acme-api-12')
    expect(renderBranch('feat/{key}-{title}', item)).toBe(
      'feat/ABC-123-fix-the-login-page-again-on-safari-firef',
    )
  })

  it('fills {type} with the conventional-commit type', () => {
    const item = { key: 'ENG-12', title: 'Login with SSO' }
    expect(renderBranch('{type}/{key}-{title}', item, 'fix')).toBe('fix/ENG-12-login-with-sso')
    expect(renderBranch('{type}/{key}', item)).toBe('chore/ENG-12')
    expect(templateProblem('{type}/{key}')).toBeUndefined()
    expect(templateProblem('{type}/work')).toBe('must contain {key} or {title}')
  })

  it('rejects templates that cannot make a branch name', () => {
    expect(templateProblem('away/{key}')).toBeUndefined()
    expect(templateProblem('feat/{title}')).toBeUndefined()
    expect(templateProblem('feat/work')).toBe('must contain {key} or {title}')
    expect(templateProblem('away/{key}/{user}')).toBe('unknown placeholder {user}')
    expect(templateProblem('away..{key}')).toMatch(/invalid branch name/)
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
  - { skill: fix, where: { checks: failing }, branch: 'fix/{key}' }
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

  it('fills {type} from the first skill in the chain that commits', () => {
    const branches = (queue: string) =>
      plan(
        `providers: [claude: {}]\nsources: { github: { repos: [acme/*] } }\nbranch: '{type}/{key}'\nqueue: [${queue}]`,
        [githubPr(1, { checks: 'failing', review_requested: true })],
        {},
      ).units.map((u) => u.unit.branch)
    expect(branches('{ skill: implement }')).toEqual(['feat/acme-api-1'])
    expect(branches('{ skill: fix }')).toEqual(['fix/acme-api-1'])
    expect(branches('{ skill: review, then: implement }')).toEqual([
      'feat/acme-api-1',
      'feat/acme-api-1',
    ])
    expect(branches('{ skill: review }')).toEqual(['chore/acme-api-1'])
  })

  it('gives a stacked slice the type of its own first skill', () => {
    const branches = (branch: string, queue: string) =>
      plan(
        `providers: [claude: {}]\nsources: { github: { repos: [acme/*] } }\nbranch: '${branch}'\nqueue: [${queue}]`,
        [githubPr(1, { checks: 'failing', review_requested: true })],
        {},
        { user: { 'write-docs': { type: 'docs' }, tidy: {} } },
      ).units.map((u) => u.unit.branch)
    const chain = '{ skill: implement, then: [review, { skill: write-docs, stack: true }, tidy] }'
    expect(branches('{type}/{key}', chain)).toEqual([
      'feat/acme-api-1',
      'feat/acme-api-1',
      'docs/acme-api-1',
      'docs/acme-api-1',
    ])
    expect(
      branches('{type}/{key}', '{ skill: fix, then: [{ skill: tidy, stack: true }] }'),
    ).toEqual(['fix/acme-api-1', 'chore/acme-api-1'])
    expect(branches('away/{key}', chain)).toEqual([
      'away/acme-api-1',
      'away/acme-api-1',
      'away/acme-api-1',
      'away/acme-api-1',
    ])
  })

  it('skips a feature whose awaywork PR waits for review, whatever item links it', () => {
    const ours = githubPr(9, { checks: 'failing', ours: true })
    const pr = { ...(ours.linkedPrs[0] as PrRef), ours: true }
    const task = asanaTask(4, {}, { linkedPrs: [pr] })
    const yaml =
      'providers: [claude: {}]\nsources: { github: { repos: [acme/*] }, asana: { workspace: "1" } }\nqueue: [{ skill: fix }]'
    const result = plan(yaml, [{ ...ours, linkedPrs: [pr] }, task], {})
    expect(result.units).toEqual([])
    expect(result.skipped.map((s) => [s.kind, s.reason])).toEqual([
      [
        'waiting_for_review',
        'waiting for review: awaywork PR https://github.com/acme/api/pull/9 is open',
      ],
      [
        'waiting_for_review',
        'waiting for review: awaywork PR https://github.com/acme/api/pull/9 is open',
      ],
    ])
    expect(result.skipped.map((s) => [s.item.key, s.url])).toEqual([
      ['acme/api#9', 'https://github.com/acme/api/pull/9'],
      ['T-4', 'https://github.com/acme/api/pull/9'],
    ])
  })

  it('holds a PR awaywork pushed onto while its head is still the one the push left', () => {
    const yaml = `
providers: [claude: {}]
sources: { github: { repos: [acme/*] } }
queue: [{ skill: fix, deliver: push }]`
    const at = (head: string, updated: string, n = 1) => {
      const item = githubPr(n, { updated })
      return { ...item, linkedPrs: [{ ...(item.linkedPrs[0] as PrRef), head }] }
    }
    const first = plan(yaml, [at('abc1234', '2026-01-01T00:00:00Z')], {})
    const outcome = { kind: 'pushed', branch: 'feature-1', commits: 1, text: '', head: 'def5678' }
    const results = [{ planned: first.units[0], status: 'done', outcome }]
    const attempts = recordAttempts({}, { runId: 'r1', plan: first, results } as RunReport)
    expect(attempts['github:acme/api#1']?.pushed).toBe('def5678')

    const pushedAt = '2026-01-02T00:00:00Z'
    const held = plan(yaml, [at('def5678', pushedAt), at('def5678', pushedAt, 2)], {}, {}, attempts)
    expect(held.units.map(({ unit }) => unit.id)).toEqual(['acme-api-2'])
    expect(held.skipped.map((s) => [s.kind, s.reason])).toEqual([
      [
        'waiting_for_review',
        'waiting for review: awaywork pushed onto your PR https://github.com/acme/api/pull/1',
      ],
    ])
    expect(held.skipped[0]?.url).toBe('https://github.com/acme/api/pull/1')
    const movedOn = plan(yaml, [at('0a1b2c3', '2026-01-03T00:00:00Z')], {}, {}, attempts)
    expect(movedOn.units).toHaveLength(1)
  })

  it('records the push of a chain aborted after it, without finishing the chain', () => {
    const yaml = `
providers: [claude: {}]
sources: { github: { repos: [acme/*] } }
queue: [{ skill: fix, deliver: push, then: review }]`
    const item = githubPr(1, { updated: '2026-01-01T00:00:00Z' })
    const planned = plan(yaml, [item], {})
    const outcome = { kind: 'pushed', branch: 'feature-1', commits: 1, text: '', head: 'def5678' }
    const [push, review] = planned.units
    const results = [
      { planned: push, status: 'done', outcome },
      { planned: review, status: 'stopped: aborted' },
    ]
    const report = { runId: 'r2', plan: planned, results } as RunReport
    const key = 'github:acme/api#1'

    const fresh = recordAttempts({}, report)
    expect(fresh[key]).toEqual({ runId: 'r2', skill: 'fix', updated: '', pushed: 'def5678' })
    expect(unchangedSince(item, 'fix', fresh)).toBeUndefined()
    const earlier = { runId: 'r1', skill: 'fix', updated: '2026-01-01T00:00:00Z', failed: 1 }
    expect(recordAttempts({ [key]: earlier }, report)[key]).toEqual({
      ...earlier,
      pushed: 'def5678',
    })
  })

  it('takes up an awaywork PR only for a rule that names ours, and bases the unit on it', () => {
    const ours = githubPr(9, { ours: true, unresolved_threads: 1, my_unresolved_threads: 1 })
    const pr = { ...(ours.linkedPrs[0] as PrRef), branch: 'away/acme-api-5', ours: true }
    const linked = { ...issue, linkedPrs: [pr] }
    const yaml = `
providers: [claude: {}]
sources: { github: { repos: [acme/*] } }
queue:
  - { skill: implement, where: { type: issue } }
  - { skill: fix, where: { type: pr, unresolved_threads: { gt: 0 } } }
  - { skill: fix, where: { type: pr, ours: true, unresolved_threads: { gt: 0 } } }`
    const result = plan(yaml, [linked, { ...ours, linkedPrs: [pr] }], {})
    expect(rows(result)).toEqual([['acme-api-9', 3, 'fix', 'claude', 'draft_pr']])
    expect(result.units[0]?.unit).toMatchObject({
      base: 'away/acme-api-5',
      branch: 'away/acme-api-9',
      foreign: false,
    })
    expect(result.units[0]?.unit.items.map((i) => i.key)).toEqual(['acme/api#9', 'acme/api#5'])
  })

  it('loops on the branch of an awaywork PR it takes up', () => {
    const ours = githubPr(9, { ours: true, unresolved_threads: 1, my_unresolved_threads: 1 })
    const pr = { ...(ours.linkedPrs[0] as PrRef), branch: 'away/acme-api-5', ours: true }
    const yaml = `
providers: [claude: {}]
sources: { github: { repos: [acme/*] } }
queue:
  - skill: fix
    where: { type: pr, ours: true }
    then: { loop: [review, fix], until: { verdict: approve }, max: 2 }`
    const result = plan(yaml, [{ ...ours, linkedPrs: [pr] }], {})
    expect(result.units.map(({ unit, chain }) => [unit.id, unit.base, chain])).toEqual([
      ['acme-api-9', 'away/acme-api-5', undefined],
      ['acme-api-9-review-1', 'away/acme-api-5', 'acme-api-9'],
      ['acme-api-9-fix-1', 'away/acme-api-5', 'acme-api-9'],
      ['acme-api-9-review-2', 'away/acme-api-5', 'acme-api-9'],
      ['acme-api-9-fix-2', 'away/acme-api-5', 'acme-api-9'],
    ])
  })

  it('addresses the threads you started on an awaywork PR by default, not anyone else', () => {
    const yaml = 'providers: [claude: {}]\nsources: { github: { repos: [acme/*] } }'
    const ours = (n: number, mine: number) => {
      const pr = githubPr(n, { ours: true, unresolved_threads: 2, my_unresolved_threads: mine })
      return { ...pr, linkedPrs: [{ ...(pr.linkedPrs[0] as PrRef), ours: true }] }
    }
    const result = plan(yaml, [ours(1, 1), ours(2, 0)], {})
    expect(rows(result)).toEqual([['acme-api-1', 3, 'fix', 'claude', 'draft_pr']])
    expect(result.skipped.map((s) => [s.kind, s.reason])).toEqual([
      [
        'waiting_for_review',
        'waiting for review: awaywork PR https://github.com/acme/api/pull/2 is open; closest #3 fix: my_unresolved_threads is 0, wants not 0',
      ],
    ])
    expect(result.skipped[0]?.url).toBe('https://github.com/acme/api/pull/2')
  })

  it('skips every item of a feature when one of them is skipped, and says why', () => {
    const pr = githubPr(1, { checks: 'failing' })
    const task = asanaTask(7, {}, { linkedPrs: pr.linkedPrs })
    const yaml =
      'providers: [claude: {}]\nsources: { github: { repos: [acme/*] }, asana: { workspace: "1" } }\nqueue: [{ skill: fix, where: { type: [pr, task] } }]'
    const result = planRun({
      config: parseConfig(yaml),
      items: [pr, task, issue],
      allowances: {},
      skills: { builtin: builtinSkills },
      skips: { 'asana:T-7': { reason: 'blocked on design' }, 'linear:acme/api#1': {} },
    })
    expect(result.units).toEqual([])
    expect(result.skipped.map((s) => [s.item.key, s.kind, s.reason])).toEqual([
      ['acme/api#5', 'no_rule', expect.stringContaining('matched no rule')],
      ['acme/api#1', 'skipped_by_you', 'skipped with awaywork skip asana:T-7: blocked on design'],
      ['T-7', 'skipped_by_you', 'skipped with awaywork skip asana:T-7: blocked on design'],
    ])
  })
})

describe('attempts', () => {
  const yaml =
    'providers: [claude: {}]\nsources: { github: { repos: [acme/*] }, asana: { workspace: "1" } }\nqueue: [{ skill: fix }]'
  const at = '2026-01-01T00:00:00Z'
  const startedAt = new Date(now)
  const failedAt = startedAt.toISOString()

  it('skips a unit none of whose items changed since a finished attempt', () => {
    const first = plan(yaml, [githubPr(1, { updated: at }), githubPr(2, { updated: at })], {})
    const [done, failed] = first.units
    const report = {
      runId: 'r1',
      startedAt,
      plan: first,
      results: [
        { planned: done, status: 'done' },
        { planned: failed, status: 'failed' },
      ],
    } as RunReport
    const attempts = recordAttempts({}, report)
    expect(attempts).toEqual({
      'github:acme/api#1': { runId: 'r1', skill: 'fix', updated: at },
      'github:acme/api#2': { runId: 'r1', skill: 'fix', updated: at, failed: 1, failedAt },
    })

    const later = '2026-01-02T00:00:00Z'
    const items = [
      githubPr(1, { updated: at }),
      githubPr(2, { updated: at }),
      githubPr(3, { updated: at }),
    ]
    const again = plan(yaml, items, {}, {}, attempts)
    expect(again.units.map((u) => u.unit.id)).toEqual(['acme-api-2', 'acme-api-3'])
    expect(again.skipped.map((s) => [s.item.key, s.kind, s.reason])).toEqual([
      ['acme/api#1', 'unchanged', 'unchanged since run r1'],
    ])
    const changed = plan(yaml, [githubPr(1, { updated: later })], {}, {}, attempts)
    expect(changed.units.map((u) => u.unit.id)).toEqual(['acme-api-1'])
  })

  it('runs a unit when any of its items changed, or has no updated time', () => {
    const pr = githubPr(1, { updated: at })
    const task = asanaTask(4, { updated: at }, { linkedPrs: pr.linkedPrs })
    const attempts = {
      'github:acme/api#1': { runId: 'r1', skill: 'fix', updated: at },
      'asana:T-4': { runId: 'r1', skill: 'fix', updated: '2025-12-31T00:00:00Z' },
    }
    expect(plan(yaml, [pr, task], {}, {}, attempts).units).toHaveLength(1)
    const bare = githubPr(1)
    const recorded = { 'github:acme/api#1': { runId: 'r1', skill: 'fix', updated: at } }
    expect(plan(yaml, [bare], {}, {}, recorded).units).toHaveLength(1)
  })

  it('runs an unchanged item again when it matches a different skill', () => {
    const recorded = { 'github:acme/api#1': { runId: 'r1', skill: 'implement', updated: at } }
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
    expect(
      recordAttempts({}, { runId: 'r1', startedAt, plan: first, results } as RunReport),
    ).toEqual({
      'github:acme/api#1': { runId: 'r1', skill: 'fix', updated: at, failed: 1, failedAt },
    })
  })

  it('loads a corrupt attempts file as empty and saves through a rename', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'attempts-'))
    const path = join(dir, 'attempts.json')
    await writeFile(path, '{"github:acme/api#1": {"runId"')
    expect(await loadAttempts(path)).toEqual({})
    const recorded = { 'github:acme/api#1': { runId: 'r1', skill: 'fix', updated: at } }
    await saveAttempts(path, recorded)
    expect(await loadAttempts(path)).toEqual(recorded)
    expect(await readdir(dir)).toEqual(['attempts.json'])
  })

  it('records a chain once, by its one publish and how its steps ended', () => {
    const chain = yaml.replace(
      '{ skill: fix }',
      '{ skill: plan, then: [implement, { loop: review, until: { verdict: approve }, max: 2 }] }',
    )
    const first = plan(chain, [githubPr(1, { updated: at })], {})
    const [head, implement, review] = first.units.map((planned) => ({ planned }))
    const record = (...results: object[]) =>
      recordAttempts({}, { runId: 'r1', startedAt, plan: first, results } as RunReport)
    const published = { ...head, status: 'done', outcome: { kind: 'pr', url: 'u', commits: 1 } }
    const finished = { 'github:acme/api#1': { runId: 'r1', skill: 'plan', updated: at } }
    const failure = {
      'github:acme/api#1': { runId: 'r1', skill: 'plan', updated: at, failed: 1, failedAt },
    }

    expect(
      record(published, { ...implement, status: 'done' }, { ...review, status: 'done' }),
    ).toEqual(finished)
    // A step that left nothing passes over the rest: the chain finished.
    const idle = { ...implement, status: 'done', made: 'nothing' }
    expect(record(published, idle, { ...review, status: 'skipped', passedOver: true })).toEqual(
      finished,
    )
    expect(
      record(published, { ...implement, status: 'failed' }, { ...review, status: 'skipped' }),
    ).toEqual(failure)
    const unpublished = { kind: 'none', reason: 'push failed', unpublished: true }
    expect(
      record({ ...published, outcome: unpublished }, { ...implement, status: 'done' }),
    ).toEqual(failure)
    const interrupted = { kind: 'none', reason: 'interrupted', unpublished: true }
    const aborted = { ...implement, status: 'stopped: aborted' }
    expect(record({ ...published, outcome: interrupted }, aborted)).toEqual({})
    expect(record({ ...head, status: 'prepared' })).toEqual({})

    const again = plan(chain, [githubPr(1, { updated: at })], {}, {}, finished)
    expect(again.units).toEqual([])
    expect(again.skipped.map((s) => s.reason)).toEqual(['unchanged since run r1'])
  })

  it('gives up after three chains that did not finish, however the item changed, for a week', () => {
    const chain = yaml.replace('{ skill: fix }', '{ skill: plan, then: implement }')
    const report = { kind: 'report', text: 'r' }
    const day = 24 * 3600_000
    const fail = (attempts: Attempts, runId: string, updated: string, time = now) => {
      const planned = plan(chain, [githubPr(1, { updated })], {}, {}, attempts, time)
      expect(planned.units).toHaveLength(2)
      const [head, implement] = planned.units
      const results = [
        { planned: head, status: 'done', outcome: report },
        { planned: implement, status: 'failed' },
      ]
      const run = { runId, startedAt: new Date(time), plan: planned, results }
      return recordAttempts(attempts, run as RunReport)
    }
    let attempts: Attempts = {}
    for (const [i, runId] of ['r1', 'r2', 'r3'].entries())
      attempts = fail(attempts, runId, `2026-01-0${i + 1}T00:00:00Z`)
    expect(attempts).toEqual({
      'github:acme/api#1': {
        runId: 'r3',
        skill: 'plan',
        updated: '2026-01-03T00:00:00Z',
        failed: 3,
        failedAt,
      },
    })
    const bumped = githubPr(1, { updated: '2026-01-05T00:00:00Z' })
    const reasons = (attempts: Attempts, time: number) =>
      plan(chain, [bumped], {}, {}, attempts, time).skipped.map((s) => s.reason)
    expect(reasons(attempts, now + 6 * day)).toEqual([
      'gave up after 3 attempts; next try on 2026-01-08',
    ])

    attempts = fail(attempts, 'r4', '2026-01-05T00:00:00Z', now + 7 * day)
    expect(attempts['github:acme/api#1']?.failed).toBe(4)
    expect(reasons(attempts, now + 8 * day)).toEqual([
      'gave up after 3 attempts; next try on 2026-01-15',
    ])
    const other = chain.replace('skill: plan', 'skill: review')
    expect(plan(other, [githubPr(1, { updated: at })], {}, {}, attempts).units).toHaveLength(2)
  })

  it('tries once more an item given up on in an attempts file without failure times', () => {
    const old = { 'github:acme/api#1': { runId: 'r3', skill: 'fix', updated: at, failed: 3 } }
    expect(plan(yaml, [githubPr(1, { updated: at })], {}, {}, old).units).toHaveLength(1)
  })

  it('clears failures on a finished attempt and ignores units that did not run', () => {
    const first = plan(yaml, [githubPr(1, { updated: at })], {})
    const failed = { 'github:acme/api#1': { runId: 'r0', skill: 'fix', updated: at, failed: 2 } }
    const recorded = (result: object) =>
      recordAttempts(failed, {
        runId: 'r1',
        startedAt,
        plan: first,
        results: [{ planned: first.units[0], ...result }],
      } as RunReport)

    expect(recorded({ status: 'done', outcome: { kind: 'pr', url: 'u', commits: 1 } })).toEqual({
      'github:acme/api#1': { runId: 'r1', skill: 'fix', updated: at },
    })
    expect(recorded({ status: 'error', reason: 'clone failed' })['github:acme/api#1']?.failed).toBe(
      3,
    )
    expect(recorded({ status: 'stopped: time' })['github:acme/api#1']?.failed).toBe(3)
    const uncounted = [
      'skipped',
      'prepared',
      'stopped: aborted',
      'stopped: quota',
      'stopped: resources',
      'stopped: session',
      'stopped: window ended',
    ]
    for (const status of uncounted) expect(recorded({ status })).toEqual(failed)
  })

  it('never gives up on an item over stops it did not cause', () => {
    let attempts: Attempts = {}
    for (const [i, runId] of ['r1', 'r2', 'r3'].entries()) {
      const planned = plan(yaml, [githubPr(1, { updated: `2026-01-0${i + 1}T00:00:00Z` })], {})
      const results = [{ planned: planned.units[0], status: 'stopped: quota' }]
      attempts = recordAttempts(attempts, { runId, startedAt, plan: planned, results } as RunReport)
    }
    expect(attempts).toEqual({})
  })

  it('tries again on the day a week after the failure, in a short DST week too', () => {
    const failed = (at: Date) => ({
      'github:acme/api#1': {
        runId: 'r3',
        skill: 'fix',
        updated: at.toISOString(),
        failed: 3,
        failedAt: at.toISOString(),
      },
    })
    const pr = githubPr(1, { updated: '2026-01-09T00:00:00Z' })
    const midnight = new Date(2026, 0, 8, 0, 0, 5)
    expect(plan(yaml, [pr], {}, {}, failed(midnight), midnight.getTime()).skipped).toMatchObject([
      { kind: 'gave_up', reason: 'gave up after 3 attempts; next try on 2026-01-15' },
    ])
    const springForward = startedAt.getTime() + (7 * 24 - 1) * 3600_000 - 3000
    expect(plan(yaml, [pr], {}, {}, failed(startedAt), springForward).units).toHaveLength(1)
  })
})

describe('waiting for an answer', () => {
  const yaml = `
providers: [claude: {}]
sources: { github: { repos: [acme/*] } }
queue:
  - skill: implement
`
  const comment = (body: string, mine?: true) => ({
    author: mine ? 'me' : 'sam',
    body,
    at: '2026-01-01T00:00:00Z',
    ...(mine && { mine }),
  })
  const asked = comment('Per user or per key?\n\n— awaywork', true)
  const withComments = (...comments: Item['comments']) =>
    plan(yaml, [{ ...issue, comments }], {}, {}, {})

  it("waits on an item whose newest comment is awaywork's questions, with no attempts kept", () => {
    const waiting = withComments(comment('Please add limits.'), asked)
    expect(waiting.units).toEqual([])
    expect(waiting.skipped).toMatchObject([
      {
        kind: 'waiting_for_answer',
        reason: 'waiting for your answer on https://example.com/1',
        url: 'https://example.com/1',
      },
    ])
    expect(needsYou.waiting_for_answer).toBe(true)
    expect(formatPlan(waiting)).toContain('api#5  waiting for your answer\n')
  })

  it('runs again once a trusted comment replies after the questions', () => {
    expect(withComments(asked, comment('Per key.')).units).toHaveLength(1)
    expect(withComments(asked, comment('Per key.', true)).units).toHaveLength(1)
  })

  it('keeps waiting when only a bot commented after the questions', () => {
    const bot = { ...comment('Coverage 91.2%'), author: 'codecov', bot: true as const }
    expect(withComments(asked, bot).skipped).toMatchObject([{ kind: 'waiting_for_answer' }])
    expect(withComments(asked, bot, comment('Per key.')).units).toHaveLength(1)
  })

  it("doesn't count awaywork's mark someone else pasted", () => {
    expect(withComments(comment('Per user?\n\n— awaywork')).units).toHaveLength(1)
  })
})

describe('a plan on the card', () => {
  const yaml = (deliver = 'plan') => `
providers: [claude: {}]
sources: { github: { repos: [acme/*] } }
queue:
  - { skill: plan, deliver: ${deliver} }
`
  const tasks =
    'tasks:\n  - { id: api, title: API }\n  - { id: web, title: Web, after: { api: opened } }'
  const at = (n: number) => `2026-01-0${n}T00:00:00Z`
  const posted = {
    author: 'me',
    body: markComment(planComment('Two tasks.', tasks)),
    at: at(1),
    mine: true as const,
  }
  const reply = (body: string, mine?: true) => ({
    author: mine ? 'me' : 'sam',
    body,
    at: at(2),
    ...(mine && { mine }),
  })
  const card = (...comments: Item['comments']) => ({ ...issue, mine: true as const, comments })
  // Unchanged since the run that posted the plan, as far as attempts tell.
  const attempts: Attempts = {
    'github:acme/api#5': { runId: 'r1', skill: 'plan', updated: '2026-01-01T00:00:00Z' },
  }

  it('plans a card with no plan, every step reporting a plan', () => {
    expect(rows(plan(yaml(), [card()], {}))).toEqual([['acme-api-5', 1, 'plan', 'claude', 'plan']])
  })

  it('waits for your approval of a plan nobody answered', () => {
    const waiting = plan(yaml(), [card(posted)], {}, {}, attempts)
    expect(waiting.units).toEqual([])
    expect(waiting.skipped).toMatchObject([
      {
        kind: 'waiting_for_approval',
        reason: 'waiting for your approval of the plan on https://example.com/1',
        url: 'https://example.com/1',
      },
    ])
    expect(needsYou.waiting_for_approval).toBe(true)
    expect(formatPlan(waiting)).toContain('api#5  waiting for your approval of the plan\n')
  })

  it('skips an approved plan, naming its tasks, as nothing for you to do', () => {
    const approved = plan(yaml(), [card(posted, reply(approveReply('Go.'), true))], {})
    expect(approved.skipped).toMatchObject([
      { kind: 'plan_approved', reason: 'plan approved, tasks api, web' },
    ])
    expect(needsYou.plan_approved).toBe(false)
  })

  it('needs you for a plan you edited into one that fails its checks', () => {
    const edited = { ...posted, body: posted.body.replace('id: web', 'id: api') }
    const refused = plan(yaml(), [card(edited)], {})
    expect(refused.skipped).toMatchObject([
      {
        kind: 'invalid_plan',
        reason: 'plan refused: task id "api" is used twice',
        url: 'https://example.com/1',
      },
    ])
    expect(needsYou.invalid_plan).toBe(true)
  })

  it('plans again on feedback, and skips a refused re-plan as unchanged until the card changes', () => {
    for (const feedback of [reply('approve if web waits'), reply('Split web.', true)]) {
      const replied = { ...card(posted, feedback), fields: { ...issue.fields, updated: at(2) } }
      expect(rows(plan(yaml(), [replied], {}, {}, attempts))).toEqual([
        ['acme-api-5', 1, 'plan', 'claude', 'plan'],
      ])
      const refused: Attempts = {
        'github:acme/api#5': { runId: 'r2', skill: 'plan', updated: at(2) },
      }
      expect(plan(yaml(), [replied], {}, {}, refused).skipped).toMatchObject([
        { kind: 'unchanged', reason: 'unchanged since run r2' },
      ])
    }
  })

  it("reads a plan only for a plan rule: another rule's questions wait as before", () => {
    expect(rows(plan(yaml('report'), [card(posted)], {}))).toEqual([
      ['acme-api-5', 1, 'plan', 'claude', 'report'],
    ])
    const asked = { ...posted, body: markComment('Per user?') }
    expect(plan(yaml(), [card(asked)], {}).skipped).toMatchObject([{ kind: 'waiting_for_answer' }])
  })
})

describe('finished items', () => {
  const day = 86_400_000
  const closed = new Date(Date.now() - 2 * day).toISOString()
  // The GitHub source links no PR to a finished item.
  const merged = { ...githubPr(8, { state: 'merged', closed, updated: closed }), linkedPrs: [] }
  const yaml = (deliver: string) => `
providers: [claude]
sources: { github: { repos: [acme/api] } }
queue: [{ skill: fix, where: { type: pr, state: merged }, deliver: ${deliver} }]
`

  it('reads a source back as far as its widest rule, and not at all when none names state', () => {
    const queue = (wheres: Rule['where'][], source?: string) =>
      wheres.map((where) => ({
        skill: 'fix',
        source,
        where,
        provider: [],
        skills: [],
        instructions: [],
      }))
    expect(finishedSince(queue([{ type: 'pr' }, { state: 'open' }]), 'github')).toBeUndefined()
    const since = finishedSince(
      queue([{ state: 'merged' }, { state: 'closed', closed: { newer_than: '14d' } }]),
      'github',
    )
    expect(Date.now() - (since?.getTime() ?? 0)).toBeCloseTo(14 * day, -3)
    expect(finishedSince(queue([{ state: 'merged' }], 'github'), 'asana')).toBeUndefined()
  })

  it('cuts a merged PR from the default branch, and refuses to push onto or review it', () => {
    const report = plan(yaml('report'), [merged], {})
    expect(report.units.map(({ unit }) => [unit.id, unit.base, unit.branch, unit.deliver])).toEqual(
      [['acme-api-8', '', 'away/acme-api-8', 'report']],
    )
    expect(plan(yaml('draft_pr'), [merged], {}).units[0]?.unit.base).toBe('')
    for (const deliver of ['push', 'pending_review'])
      expect(() => parseConfig(yaml(deliver))).toThrow(
        `queue[0].deliver: ${deliver} needs an open PR, and this rule matches only merged or closed items; use report, draft_pr or pr`,
      )
    const recent = yaml('push').replace(
      'state: merged',
      'state: [open, merged], closed: { newer_than: 1d }',
    )
    expect(() => parseConfig(recent)).toThrow('queue[0].deliver: push needs an open PR')
    const mixed = yaml('push').replace('state: merged', 'state: [open, merged]')
    expect(plan(mixed, [merged], {}).skipped.map((s) => [s.kind, s.reason])).toEqual([
      ['refused_delivery', 'deliver push: no PR of yours to push onto'],
    ])
  })

  it('says a finished item misses a rule that never names state', () => {
    const open = yaml('report').replace('state: merged', 'mine: true')
    expect(plan(open, [merged], {}).skipped.map((s) => s.reason)).toEqual([
      'matched no rule; closest #1 fix: state is merged, wants open',
    ])
  })

  it('runs once per finished item, and again on a PR that merged since', () => {
    const first = plan(yaml('report'), [merged], {})
    const report = {
      runId: 'r1',
      startedAt: new Date(now),
      plan: first,
      results: [{ planned: first.units[0], status: 'done' }],
    } as RunReport
    const attempts = recordAttempts({}, report)
    expect(attempts['github:acme/api#8']).toMatchObject({ updated: closed, state: 'merged' })
    expect(plan(yaml('report'), [merged], {}, {}, attempts).skipped.map((s) => s.kind)).toEqual([
      'unchanged',
    ])
    const open = { 'github:acme/api#8': { runId: 'r0', skill: 'fix', updated: closed } }
    expect(unchangedSince(merged, 'fix', open)).toBeUndefined()
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
    expect(json.skipped[0]).toMatchObject({ kind: 'no_rule', item: { key: 'acme/api#3' } })
  })
})

describe('ruleNumber', () => {
  it('takes whole numbers from 1', () => expect(ruleNumber('3')).toBe(3))
  it.each(['0', '-1', '1.5', 'abc'])('rejects %s', (text) =>
    expect(() => ruleNumber(text)).toThrow('a rule number from 1'),
  )
})
