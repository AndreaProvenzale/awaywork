import { describe, expect, it } from 'vitest'
import { parseConfig } from '#config/load'
import { setupOf } from '#config/skills'
import { builtinSkills } from '#core/skills'
import type { Item, PrRef, TaskPr } from '#core/types'
import { planRun } from '#plan/foreman'
import { approveReply, markComment, planComment, resultComment } from '#posts/comments'
import { allowance } from '#quota/budget'
import { fakeItem, githubPr } from './fakes/items'

const base = (limits: string, queue: string) => `
limits: ${limits}
providers: [claude: {}]
repos: { acme/*: {} }
sources: { github: {} }
queue:
${queue}
`

const plan = (yaml: string, items: Item[], only?: { named: string }) => {
  const config = parseConfig(yaml)
  return planRun({
    setup: setupOf(config, { builtin: builtinSkills }),
    items,
    allowances: { claude: allowance(config.budget, null, 0, config.windows) },
    now: Date.parse('2026-01-01T00:00:00Z'),
    only,
  })
}
const ids = (p: ReturnType<typeof plan>) => p.units.map((u) => u.unit.id)
const capped = (p: ReturnType<typeof plan>) =>
  p.skipped.filter((s) => s.kind === 'over_cap').map((s) => [s.item.key, s.reason])

const ours = (n: number, more: Partial<PrRef> = {}): PrRef => ({
  ...(githubPr(n).linkedPrs[0] as PrRef),
  ours: true,
  ...more,
})
const issue = (n: number, more: Partial<Item> = {}) =>
  fakeItem({
    source: 'github',
    id: String(n),
    key: `acme/api#${n}`,
    type: 'issue',
    url: `https://github.com/acme/api/issues/${n}`,
    mine: true,
    fields: { repo: 'acme/api', mine: true },
    ...more,
  })
/** An issue whose awaywork PR is open and waits for review. */
const open = (n: number) => issue(n, { linkedPrs: [ours(n + 100)] })
const rule = (extra = '') => `  - { skill: implement, where: { type: issue }${extra} }`
const at = '2026-01-01T00:00:00Z'

describe('units_max_open', () => {
  it('holds a rule at its own cap, naming it, and counts what this run takes', () => {
    const p = plan(base('{}', rule(', units_max_open: 2')), [open(1), issue(2), issue(3)])
    expect(ids(p)).toEqual(['acme-api-2'])
    expect(capped(p)).toEqual([['acme/api#3', 'over the cap: rule #1 units_max_open is 2']])
  })

  it('holds every rule at the total, which wins over a rule cap', () => {
    const yaml = base(
      '{ units_max_open: 2 }',
      `${rule(', units_max_open: 2')}\n  - { skill: fix, where: { type: pr, mine: true } }`,
    )
    const p = plan(yaml, [open(1), issue(2), issue(3), githubPr(7, { checks: 'failing' })])
    expect(ids(p)).toEqual(['acme-api-2'])
    expect(capped(p)).toEqual([
      ['acme/api#3', 'over the cap: limits.units_max_open is 2'],
      ['acme/api#7', 'over the cap: limits.units_max_open is 2'],
    ])
  })

  it('counts an awaywork PR no rule takes toward the total only', () => {
    const stray = githubPr(9, { ours: true })
    const total = base('{ units_max_open: 1 }', rule(', units_max_open: 5'))
    expect(capped(plan(total, [stray, issue(2)]))).toEqual([
      ['acme/api#2', 'over the cap: limits.units_max_open is 1'],
    ])
    expect(ids(plan(base('{}', rule(', units_max_open: 1')), [stray, issue(2)]))).toEqual([
      'acme-api-2',
    ])
  })

  it('counts a draft that goes on once, and never holds going on with it', () => {
    const left = {
      items: ['github:acme/api#1'],
      status: 'continue' as const,
      continued: 0,
      head: 'h',
      from: 'f',
    }
    const draft = issue(1, { linkedPrs: [ours(101, { head: 'h', left })] })
    const p = plan(base('{}', rule(', units_max_open: 1')), [draft, issue(2)])
    expect(ids(p)).toEqual(['acme-api-1'])
    expect(capped(p)).toEqual([['acme/api#2', 'over the cap: rule #1 units_max_open is 1']])
  })

  it("never holds a rule taking up awaywork's PR", () => {
    const taken = { ...githubPr(9, { ours: true, checks: 'failing' }), linkedPrs: [ours(9)] }
    const yaml = base(
      '{}',
      `  - { skill: fix, where: { type: pr, ours: true }, units_max_open: 1 }\n${rule(', units_max_open: 1')}`,
    )
    expect(ids(plan(yaml, [taken, issue(2)]))).toEqual(['acme-api-9', 'acme-api-2'])
  })

  it('never holds the rerun after you answered its questions', () => {
    const comment = (body: string, mine?: true) => ({
      author: mine ? 'me' : 'sam',
      body,
      at,
      ...(mine && { mine }),
    })
    const answered = issue(1, {
      comments: [comment('Per key?\n\n— awaywork', true), comment('Per key.')],
    })
    expect(ids(plan(base('{ units_max_open: 1 }', rule()), [open(2), answered]))).toEqual([
      'acme-api-1',
    ])
  })

  it('never holds the rerun after feedback on a waiting post', () => {
    const post = resultComment('Looks fine.', 'done', 'review', undefined, 0, true)
    const reported = issue(1, {
      comments: [
        { author: 'me', body: markComment(post, { waits: true }), at, mine: true },
        { author: 'me', body: 'More detail.', at: '2026-01-02T00:00:00Z', mine: true },
      ],
    })
    const yaml = base(
      '{}',
      '  - { skill: review, where: { type: issue }, deliver: report, units_max_open: 1 }',
    )
    expect(ids(plan(yaml, [open(2), reported]))).toEqual(['acme-api-1'])
  })

  it('counts a chain and its loop once', () => {
    const yaml = base(
      '{ units_max_open: 1 }',
      '  - { skill: implement, where: { type: issue }, then: [{ skill: docs }, { loop: [review, fix], until: { verdict: approve }, max: 1 }] }',
    )
    const p = plan(yaml, [issue(1), issue(2)])
    expect(new Set(p.units.map((u) => u.unit.items[0]?.key))).toEqual(new Set(['acme/api#1']))
    expect(capped(p)).toEqual([['acme/api#2', 'over the cap: limits.units_max_open is 1']])
  })

  it('goes past the cap for the unit you name', () => {
    const p = plan(base('{}', rule(', units_max_open: 1')), [open(1), issue(2), issue(3)], {
      named: 'acme/api#2',
    })
    expect(ids(p)).toEqual(['acme-api-2'])
  })

  it('counts a plan waiting for approval, and not a report that went ahead', () => {
    const waiting = issue(1, {
      comments: [
        {
          author: 'me',
          body: markComment(planComment('Tasks.', 'tasks:\n  - { id: api, title: A }'), {
            waits: true,
          }),
          at,
          mine: true,
        },
      ],
    })
    const yaml = base(
      '{}',
      '  - { skill: plan, deliver: plan, where: { type: issue }, units_max_open: 1 }\n  - { skill: implement, where: { planned: true } }',
    )
    expect(capped(plan(yaml, [waiting, issue(2)]))).toEqual([
      ['acme/api#2', 'over the cap: rule #1 units_max_open is 1'],
    ])
    const went = issue(1, {
      comments: [
        {
          author: 'me',
          body: markComment(resultComment('Fine.', 'done', 'review'), { went: true, gates: [] }),
          at,
          mine: true,
        },
      ],
    })
    const report = base(
      '{}',
      '  - { skill: review, where: { type: issue }, deliver: report, units_max_open: 1 }',
    )
    expect(capped(plan(report, [went, issue(2)]))).toEqual([])
  })

  it("doesn't count what asks for a fix", () => {
    const yaml = base('{}', rule(', units_max_open: 1, deliver: pending_review'))
    const p = plan(yaml, [issue(1), issue(2)])
    expect(p.skipped.every((s) => s.kind === 'refused_delivery')).toBe(true)
    expect(capped(p)).toEqual([])
  })
})

describe('units_max_open for tasks', () => {
  const day = (n: number) => `2026-10-2${n}T00:00:00Z`
  const tasks = `tasks:
  - { id: api, title: A }
  - { id: web, title: W }
  - { id: docs, title: D }`
  const taskPr = (id: string): TaskPr => ({
    repo: 'acme/api',
    number: id.length,
    url: `https://github.com/acme/api/pull/${id}`,
    branch: `away/acme-api-1-${id}`,
    ours: true,
    mine: true,
    trusted: true,
    fork: false,
    state: 'open',
  })
  const card = (n: number, taskPrs: Record<string, TaskPr> = {}) =>
    issue(n, {
      comments: [
        { author: 'me', body: markComment(planComment('Plan.', tasks)), at: day(1), mine: true },
        { author: 'me', body: approveReply(''), at: day(2), mine: true },
      ],
      taskPrs,
    })
  const yaml = base(
    '{}',
    '  - { skill: plan, deliver: plan, where: { type: issue } }\n  - { skill: implement, where: { planned: true }, units_max_open: 1 }',
  )

  it("counts a card once while a task has a PR, and holds a new card's tasks", () => {
    const p = plan(yaml, [card(1, { api: taskPr('api') }), card(2)])
    expect(ids(p)).toEqual(['acme-api-1-web', 'acme-api-1-docs'])
    expect(capped(p).map(([key]) => key)).toEqual([
      'acme/api#2/api',
      'acme/api#2/web',
      'acme/api#2/docs',
    ])
  })

  it("takes a new card's tasks together, never cutting a block under way", () => {
    expect(ids(plan(yaml, [card(1)]))).toEqual([
      'acme-api-1-api',
      'acme-api-1-web',
      'acme-api-1-docs',
    ])
  })
})
