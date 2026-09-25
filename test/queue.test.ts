import { describe, expect, it } from 'vitest'
import { matches, rank } from '../src/core/queue.js'
import type { Rule } from '../src/core/types.js'
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
