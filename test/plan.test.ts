import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import { formatPlan } from '../src/cli/format.js'
import { parseConfig } from '../src/config/load.js'
import { type Allowance, allowance } from '../src/core/budget.js'
import { planNight } from '../src/core/foreman.js'
import { builtinSkills, type SkillCatalog } from '../src/core/skills.js'
import type { Item, Quota } from '../src/core/types.js'
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
    expect(result.units[0]?.unit).toMatchObject({ base: 'feature-1', branch: 'night/acme-api-1' })
    expect(formatPlan(result)).toMatchInlineSnapshot(`
      "Queue
        #1  fix-ci     type=pr mine=true checks=failing
        #2  implement  source=github type=issue label=night-shift repo=acme/api
        #3  review     type=pr review_requested=true
        #4  implement  source=asana section=Ready tags=backend provider=codex

      Providers
        claude  seven_day 36% used, ceiling 51% set by per_night (reserve 90%, pacing 54%; 3 nights to reset); session 2%, workers stop at 90%
        codex   fallback: 4 units, 60 turns each (no quota reading)

      Units
           unit        repo      rule  skill                provider  deliver
        1  acme-api-1  acme/api  #1    fix-ci (builtin)     claude    draft_pr
           github acme/api#1: PR 1
           + asana T-7: same feature, matched #4
        2  acme-api-5  acme/api  #2    implement (builtin)  claude    draft_pr
           github acme/api#5: Add rate limits
        3  acme-api-2  acme/api  #3    review (builtin)     claude    report
           github acme/api#2: PR 2

      Skipped
        github acme/api#3: matched no rule
        asana T-8: no repo: no linked PR or repo field"
    `)
  })

  it('uses the default queue for configured sources only', () => {
    const yaml = 'providers: [claude: {}]\nsources: { github: { repos: [acme/*] } }'
    const items = [
      githubPr(1, { mine: false, review_requested: true }),
      githubPr(2, { unresolved_threads: 4 }),
      githubPr(3, { checks: 'failing', unresolved_threads: 2 }),
    ]
    const result = plan(yaml, items, { claude: week(0.1) })
    expect(result.defaultQueue).toBe(true)
    expect(result.queue.map((r) => r.skill)).toEqual(['fix-ci', 'address-review', 'review'])
    expect(rows(result).map((r) => [r[0], r[2]])).toEqual([
      ['acme-api-3', 'fix-ci'],
      ['acme-api-2', 'address-review'],
      ['acme-api-1', 'review'],
    ])
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

  it('gathers every instruction file for the unit in prompt order', () => {
    const [first] = plan(example, [githubPr(1, { checks: 'failing' })], {}).units
    expect(first?.unit.instructions).toEqual(['notes/me.md', 'notes/acme-api.md'])
  })
})
