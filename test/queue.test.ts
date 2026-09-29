import { describe, expect, it } from 'vitest'

import { closestRule, failedKeys, matches, rank, ruleMatches } from '../src/core/queue.js'
import type { Order, Rule } from '../src/core/types.js'

import { asanaTask, githubPr } from './fakes/items.js'

const rule = (where: Rule['where'], source?: string): Rule => ({
  skill: 'fix-ci',
  source,
  where,
  provider: [],
  skills: [],
  instructions: [],
})

describe('where', () => {
  const pr = githubPr(1, {
    checks: 'failing',
    unresolved_threads: 3,
    label: ['bug', 'night-shift'],
  })

  it.each([
    ['a scalar equals', { checks: 'failing' }, true],
    ['a scalar mismatch', { checks: 'passing' }, false],
    ['a list is any of', { checks: ['pending', 'failing'] }, true],
    ['not negates a scalar', { unresolved_threads: { not: 0 } }, true],
    ['not negates a list', { checks: { not: ['failing', 'pending'] } }, false],
    ['a scalar is contained in a list field', { label: 'night-shift' }, true],
    ['a list overlaps a list field', { label: ['docs', 'bug'] }, true],
    ['type matches the item type', { type: 'pr' }, true],
    ['a missing field never equals', { review_requested: true }, false],
    ['a missing field is not anything', { review_requested: { not: true } }, true],
    ['gte compares a number', { unresolved_threads: { gte: 3 } }, true],
    ['lt compares a number', { unresolved_threads: { lt: 3 } }, false],
    ['comparisons combine into a range', { unresolved_threads: { gt: 1, lte: 5 } }, true],
    ['a comparison never matches a missing field', { review_requested: { lt: 1 } }, false],
    ['a comparison never matches a string', { checks: { gt: 0 } }, false],
    ['every key must match', { type: 'pr', checks: 'passing' }, false],
    ['no keys match everything', {}, true],
  ] as const)('%s', (_, where, expected) => {
    expect(matches(rule(where as Rule['where']), pr)).toBe(expected)
  })

  it('restricts a rule to its source', () => {
    expect(matches(rule({}, 'asana'), pr)).toBe(false)
    expect(matches(rule({}, 'github'), pr)).toBe(true)
  })
})

describe('rank', () => {
  it('orders by first matching rule, then source order, and sets aside unmatched items', () => {
    const queue = [rule({ checks: 'failing' }), rule({ type: 'task' })]
    const items = [
      githubPr(1),
      asanaTask(2),
      githubPr(3, { checks: 'failing' }),
      githubPr(4, { checks: 'failing' }),
    ]
    const { ranked, unmatched } = rank(items, queue)
    expect(ranked.map((r) => [r.item.key, r.rule])).toEqual([
      ['acme/api#3', 0],
      ['acme/api#4', 0],
      ['T-2', 1],
    ])
    expect(unmatched.map((i) => i.key)).toEqual(['acme/api#1'])
  })
})

describe('closestRule', () => {
  it('names the keys an item fails', () => {
    const where = { type: 'pr', checks: 'failing', mine: true } as const
    expect(failedKeys(rule(where), githubPr(1, { mine: false }))).toEqual(['checks', 'mine'])
  })

  it('picks the rule with the fewest failed keys, the earlier on a tie, for the item source', () => {
    const queue = [
      rule({}, 'asana'),
      rule({ checks: 'failing', mine: false }),
      rule({ checks: 'failing' }, 'github'),
      rule({ review_requested: true }),
    ]
    expect(closestRule(githubPr(1), queue)).toEqual({ rule: 2, failed: ['checks'] })
    expect(closestRule(githubPr(1), [rule({}, 'asana')])).toBeUndefined()
  })
})

describe('order', () => {
  const pr = (n: number, created?: string, updated?: string) =>
    githubPr(n, { ...(created && { created }), ...(updated && { updated }) })
  const items = [
    pr(1, '2026-03-01T00:00:00Z', '2026-03-02T00:00:00Z'),
    pr(2),
    pr(3, '2026-01-01T00:00:00Z', '2026-04-01T00:00:00Z'),
    pr(4, '2026-02-01T00:00:00.000Z', '2026-02-02T00:00:00.000Z'),
  ]
  const ordered = (order?: Order) =>
    rank(items, [{ ...rule({}), order }]).ranked.map((r) => r.item.id)

  it.each([
    [undefined, ['1', '2', '3', '4']],
    ['oldest', ['3', '4', '1', '2']],
    ['newest', ['1', '4', '3', '2']],
    ['updated', ['3', '1', '4', '2']],
  ] as const)('%s puts items without the timestamp last', (order, expected) => {
    expect(ordered(order)).toEqual(expected)
  })

  it('sorts within a rule, after the rule index', () => {
    const queue = [rule({ type: 'task' }), { ...rule({}), order: 'oldest' as const }]
    const ranked = rank([...items, asanaTask(5)], queue).ranked
    expect(ranked.map((r) => r.item.id)).toEqual(['5', '3', '4', '1', '2'])
  })

  it('orders what each rule takes', () => {
    const [taken] = ruleMatches(items, [{ ...rule({}), order: 'newest' }])
    expect(taken?.taken.map((i) => i.id)).toEqual(['1', '4', '3', '2'])
  })
})
