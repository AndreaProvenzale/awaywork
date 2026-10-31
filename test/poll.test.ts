import { describe, expect, it, vi } from 'vitest'
import { describeRule, formatPlan } from '../src/cli/format.js'
import { parseConfig } from '../src/config/load.js'
import type { Attempts } from '../src/core/attempts.js'
import { planRun } from '../src/core/foreman.js'
import {
  claimUnits,
  dueUnits,
  httpError,
  nextPoll,
  releaseUnits,
  type Seen,
  soonSources,
} from '../src/core/poll.js'
import { builtinSkills } from '../src/core/skills.js'
import type { Item, Rule } from '../src/core/types.js'
import { type RoutinesConfig, routines } from '../src/sources/routines.js'
import { fakeItem } from './fakes/items.js'

const MINUTE = 60_000
const HOUR = 60 * MINUTE

const config = parseConfig(`
providers: [claude]
sources: { github: { repos: [acme/*] }, chores: { command: ./chores.sh, every: 15m } }
queue:
  - skill: fix
    where: { type: pr }
  - skill: implement
    source: github
    run: soon
    then: [{ skill: review }]
`)

const issue = (n: number, updated: string, comments: Item['comments'] = []) =>
  fakeItem({
    source: 'github',
    id: String(n),
    key: `acme/api#${n}`,
    type: 'issue',
    url: `https://github.com/acme/api/issues/${n}`,
    comments,
    fields: { repo: 'acme/api', updated },
  })

/** A poll's plan: the soon rules only, no provider read. */
const poll = (items: Item[], attempts: Attempts = {}) =>
  planRun({
    config,
    items,
    allowances: {},
    skills: { builtin: builtinSkills },
    attempts,
    only: { soon: true },
  })

describe('due units', () => {
  const asked = {
    author: 'me',
    body: 'Per user or per key?\n\n— awaywork',
    at: 'x',
    mine: true as const,
  }
  const reply = { author: 'sam', body: 'Per key.', at: 'y' }

  it('starts a new item, not again once a run took it, then again when it changes', () => {
    const held = new Map<string, string>()
    const seen: Seen = new Map()
    const first = poll([issue(5, '2026-10-25T10:00:00Z'), fakeItem({ key: 'PR-1' })])
    expect(dueUnits(first, {}, seen, held, 0)).toEqual(['acme-api-5'])
    claimUnits(first, 'r1', held, seen, 0)
    releaseUnits(held, 'r1')
    // It failed: the attempt keeps it planned, but nothing changed since.
    const failed: Attempts = {
      'github:acme/api#5': {
        runId: 'r1',
        skill: 'implement',
        updated: '2026-10-25T10:00:00Z',
        failed: 1,
      },
    }
    const again = poll([issue(5, '2026-10-25T10:00:00Z')], failed)
    expect(again.units).not.toEqual([])
    expect(dueUnits(again, failed, seen, held, 2 * HOUR)).toEqual([])
    // Same after a restart, from the attempt alone.
    expect(dueUnits(again, failed, new Map(), held, 0)).toEqual([])
    const changed = poll([issue(5, '2026-10-25T11:00:00Z')], failed)
    expect(dueUnits(changed, failed, seen, held, 0)).toEqual(['acme-api-5'])
  })

  it('starts a unit its run took and never attempted again an hour on', () => {
    const seen: Seen = new Map([['github:acme/api#5', { updated: '2026-10-25T10:00:00Z', at: 0 }]])
    const plan = poll([issue(5, '2026-10-25T10:00:00Z')])
    expect(dueUnits(plan, {}, seen, new Map(), HOUR - 1)).toEqual([])
    expect(dueUnits(plan, {}, seen, new Map(), HOUR)).toEqual(['acme-api-5'])
  })

  it("doesn't count awaywork's own questions as a change, and does count the reply", () => {
    const seen: Seen = new Map([['github:acme/api#5', { updated: '2026-10-25T10:00:00Z', at: 0 }]])
    const questions = poll([issue(5, '2026-10-25T10:05:00Z', [asked])])
    expect(questions.skipped).toMatchObject([{ kind: 'waiting_for_answer' }])
    expect(dueUnits(questions, {}, seen, new Map(), 0)).toEqual([])
    const answered = poll([issue(5, '2026-10-25T10:30:00Z', [asked, reply])])
    expect(dueUnits(answered, {}, seen, new Map(), 0)).toEqual(['acme-api-5'])
  })

  it('starts a routine once it comes due, not again once attempted, and at its next occurrence', async () => {
    const routineConfig = parseConfig(`
providers: [claude]
sources:
  routines:
    standup: { at: ["09:00", "14:00"], repo: acme/api, title: Write the standup notes }
queue:
  - { skill: report, source: routines, deliver: report, run: soon }
`)
    const at = async (time: string, attempts: Attempts) => {
      vi.useFakeTimers({ toFake: ['Date'] })
      vi.setSystemTime(new Date(time))
      const cfg = routineConfig.sources.routines as RoutinesConfig
      const items = await routines.items(cfg, { env: {}, log: () => {} })
      vi.useRealTimers()
      const plan = planRun({
        config: routineConfig,
        items,
        allowances: {},
        skills: { builtin: builtinSkills },
        attempts,
        only: { soon: true },
      })
      return dueUnits(plan, attempts, new Map(), new Map(), 0)
    }
    expect(await at('2026-10-26T09:01', {})).toEqual(['standup-20261026-0900'])
    const attempts: Attempts = {
      'routines:standup-20261026-0900': {
        runId: 'r1',
        skill: 'report',
        updated: new Date('2026-10-26T09:00').toISOString(),
      },
    }
    expect(await at('2026-10-26T13:59', attempts)).toEqual([])
    expect(await at('2026-10-26T14:00', attempts)).toEqual(['standup-20261026-1400'])
  })

  it('leaves out a unit another run is working on', () => {
    const plan = poll([issue(5, '2026-10-25T10:00:00Z')])
    const held = new Map([['github:acme/api#5', '20261025-010000']])
    expect(dueUnits(plan, {}, new Map(), held, 0)).toEqual([])
  })
})

describe('per-unit locks', () => {
  const plan = (...ns: number[]) => poll(ns.map((n) => issue(n, '2026-10-25T10:00:00Z')))

  it('skips the units another run holds, with their chain, until it ends', () => {
    const held = new Map<string, string>()
    const seen: Seen = new Map()
    const window = claimUnits(plan(5, 6), '20261025-010000', held, seen, 0)
    expect(window.units.map((p) => p.unit.id)).toEqual([
      'acme-api-5',
      'acme-api-5-review',
      'acme-api-6',
      'acme-api-6-review',
    ])
    const soon = claimUnits(plan(6, 7), '20261025-011500', held, seen, 0)
    expect(soon.units.map((p) => p.unit.id)).toEqual(['acme-api-7', 'acme-api-7-review'])
    expect(soon.skipped).toMatchObject([
      { item: { key: 'acme/api#6' }, kind: 'running', reason: 'running in run 20261025-010000' },
    ])
    expect(seen.get('github:acme/api#7')).toEqual({ updated: '2026-10-25T10:00:00Z', at: 0 })
    releaseUnits(held, '20261025-010000')
    const later = claimUnits(plan(6), '20261025-013000', held, seen, 0)
    expect(later.units.map((p) => p.unit.id)).toEqual(['acme-api-6', 'acme-api-6-review'])
    expect(held.get('github:acme/api#7')).toBe('20261025-011500')
  })
})

it('awaywork plan marks the soon rules', () => {
  const plan = poll([issue(5, '2026-10-25T10:00:00Z')])
  expect(formatPlan(plan)).toMatch(/1 +api#5 +#2 soon +implement/)
  expect(describeRule(config.queue?.[1] as Rule)).toBe('source=github run=soon then=review')
})

describe('polling', () => {
  it('polls only the sources soon rules read, a source no more often than watch.every', () => {
    expect(soonSources(config)).toEqual({ github: 5 * MINUTE })
    const any = parseConfig(`
providers: [claude]
watch: { every: 10m }
sources: { github: { repos: [acme/*], every: 1m }, chores: { command: ./chores.sh, every: 1h } }
queue: [{ skill: fix, run: soon }]
`)
    expect(soonSources(any)).toEqual({ github: 10 * MINUTE, chores: 60 * MINUTE })
    expect(
      soonSources(parseConfig('providers: [claude]\nsources: { github: { repos: [acme/*] } }')),
    ).toEqual({})
    for (const zero of ['watch: { every: 0m }', 'sources: { github: { repos: [a/*], every: 0h } }'])
      expect(() => parseConfig(`providers: [claude]\n${zero}`)).toThrow(/a span of 1m or more/)
  })

  it('doubles the interval per failure up to an hour, back to normal on success', () => {
    const every = 5 * MINUTE
    expect(nextPoll(every, 0)).toEqual({ next: every })
    expect(nextPoll(every, 0, { failures: 1 })).toEqual({ next: 10 * MINUTE, failures: 1 })
    expect(nextPoll(every, 0, { failures: 3 })).toEqual({ next: 40 * MINUTE, failures: 3 })
    expect(nextPoll(every, 0, { failures: 4 })).toEqual({ next: 60 * MINUTE, failures: 4 })
    expect(nextPoll(2 * 60 * MINUTE, 0, { failures: 1 }).next).toBe(2 * 60 * MINUTE)
  })

  it('counts the interval from the minute the poll ran in, so a slow poll never slips a tick', () => {
    expect(nextPoll(5 * MINUTE, 3 * MINUTE + 12_345)).toEqual({ next: 8 * MINUTE })
    expect(nextPoll(5 * MINUTE, 12_345, { failures: 1 }).next).toBe(10 * MINUTE)
    expect(nextPoll(5 * MINUTE, 30_000, { failures: 1, retryAfter: 30 * MINUTE }).next).toBe(
      31 * MINUTE,
    )
  })

  it("waits as long as a 429's Retry-After asks, never less than the interval", () => {
    const limited = httpError(
      'Jira /search: 429',
      new Response('', {
        status: 429,
        headers: { 'retry-after': '1800' },
      }),
    )
    expect(limited.retryAfter).toBe(30 * MINUTE)
    expect(nextPoll(5 * MINUTE, 0, { failures: 1, retryAfter: limited.retryAfter })).toEqual({
      next: 30 * MINUTE,
      failures: 1,
    })
    expect(nextPoll(5 * MINUTE, 0, { failures: 1, retryAfter: 1000 }).next).toBe(5 * MINUTE)
    const down = httpError('Jira /search: 503', new Response('', { status: 503 }))
    expect(down.retryAfter).toBeUndefined()
    expect(down.message).toBe('Jira /search: 503')
  })
})
