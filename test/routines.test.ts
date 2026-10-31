import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'
import { formatWhy } from '../src/cli/format.js'
import { ConfigError, parseConfig } from '../src/config/load.js'
import type { Attempts } from '../src/core/attempts.js'
import { planRun } from '../src/core/foreman.js'
import { builtinSkills } from '../src/core/skills.js'
import {
  lastOccurrence,
  nextOccurrence,
  nextOccurrences,
  type Routine,
  type RoutinesConfig,
  routines,
} from '../src/sources/routines.js'

// Rome leaves summer time on 2026-10-25 at 03:00, back to 02:00.
const zone = process.env.TZ
process.env.TZ = 'Europe/Rome'
afterAll(() => {
  process.env.TZ = zone
})
afterEach(() => {
  vi.useRealTimers()
})

const local = (time: string) => new Date(time)
const routine = (r: Partial<Routine> = {}): Routine => ({
  at: ['09:00'],
  repo: 'acme/api',
  title: 'Triage',
  description: '',
  ...r,
})

describe('the latest occurrence', () => {
  it.each([
    ['every day, before today’s', routine(), '2026-10-28T08:59', '2026-10-27T09:00'],
    ['every day, at today’s', routine(), '2026-10-28T09:00', '2026-10-28T09:00'],
    ['mondays, midweek', routine({ days: ['mon'] }), '2026-10-28T12:00', '2026-10-26T09:00'],
    ['mondays, early monday', routine({ days: ['mon'] }), '2026-10-26T08:00', '2026-10-19T09:00'],
  ])('%s', (_, r, now, last) => {
    expect(lastOccurrence(r, local(now))).toEqual(local(last))
  })

  it('takes the latest of a list of times, in any order', () => {
    const r = routine({ days: ['mon', 'thu'], at: ['14:00', '09:00'] })
    expect(lastOccurrence(r, local('2026-10-29T12:00'))).toEqual(local('2026-10-29T09:00'))
    expect(lastOccurrence(r, local('2026-10-30T08:00'))).toEqual(local('2026-10-29T14:00'))
    expect(lastOccurrence(r, local('2026-11-02T08:00'))).toEqual(local('2026-10-29T14:00'))
    expect(nextOccurrence(r, local('2026-10-29T14:00'))).toEqual(local('2026-11-02T09:00'))
  })

  it('keeps local time across the end of summer time', () => {
    const daily = routine()
    expect(lastOccurrence(daily, local('2026-10-25T08:30')).toISOString()).toBe(
      '2026-10-24T07:00:00.000Z',
    )
    expect(nextOccurrence(daily, local('2026-10-25T08:30')).toISOString()).toBe(
      '2026-10-25T08:00:00.000Z',
    )
    const weekly = routine({ days: ['mon'] })
    expect(lastOccurrence(weekly, local('2026-10-26T10:00')).toISOString()).toBe(
      '2026-10-26T08:00:00.000Z',
    )
    expect(lastOccurrence(weekly, local('2026-10-26T08:00')).toISOString()).toBe(
      '2026-10-19T07:00:00.000Z',
    )
  })
})

const config = (sources: string, queue = '') =>
  parseConfig(`providers: [claude]\nsources:\n${sources}\n${queue}`)

const triage = `  routines:
    sentry-triage:
      days: [mon]
      at: "09:00"
      repo: acme/api
      title: Triage last week's Sentry issues
      description: Group new issues, link duplicates.`

describe('routine items', () => {
  const itemsAt = async (now: string, sources = triage) => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(local(now))
    const cfg = config(sources).sources.routines as RoutinesConfig
    return routines.items(cfg, { env: {}, log: () => {} })
  }

  it('is one task per routine: its latest occurrence, yours, linking its repo', async () => {
    expect(await itemsAt('2026-10-28T12:00')).toEqual([
      {
        source: 'routines',
        id: 'sentry-triage-20261026-0900',
        key: 'sentry-triage-20261026-0900',
        type: 'task',
        title: "Triage last week's Sentry issues",
        description: 'Group new issues, link duplicates.',
        url: 'https://github.com/acme/api',
        status: 'open',
        reviewers: [],
        labels: [],
        comments: [],
        linkedPrs: [],
        fields: {
          name: 'sentry-triage',
          repo: 'acme/api',
          created: '2026-10-26T08:00:00.000Z',
          updated: '2026-10-26T08:00:00.000Z',
          state: 'open',
        },
        mine: true,
        raw: expect.anything(),
      },
    ])
  })

  it('makes a machine asleep all week one item, never a backlog', async () => {
    const twice = '  routines:\n    tidy: { at: ["09:00", "14:00"], repo: acme/api, title: Tidy }'
    const items = await itemsAt('2026-11-04T10:00', twice)
    expect(items.map((i) => i.key)).toEqual(['tidy-20261104-0900'])
  })

  it('links the repo on the configured forge', async () => {
    const at = (sources: string) => itemsAt('2026-10-28T12:00', `${sources}\n${triage}`)
    const [enterprise] = await at('  github: { repos: [acme/*], host: github.acme.com }')
    expect(enterprise?.url).toBe('https://github.acme.com/acme/api')
    const [bitbucket] = await at('  bitbucket: { repos: [acme/*] }')
    expect(bitbucket?.url).toBe('https://bitbucket.org/acme/api')
  })
})

describe('routine config', () => {
  const problems = (sources: string, queue = '') => {
    try {
      config(sources, queue)
      return []
    } catch (e) {
      if (e instanceof ConfigError) return e.problems
      throw e
    }
  }
  const rule = (extra: string) => `queue:\n  - { skill: triage, source: routines, ${extra} }`

  it('refuses what needs a tracker to write to', () => {
    expect(problems(triage, rule('on_done: { comment: result }'))).toEqual([
      expect.stringMatching(/^queue\[0\]\.on_done: a routine has no tracker to post a result on/),
    ])
    expect(problems(triage, rule('deliver: plan'))).toContain(
      "queue[0].deliver: plan posts on the item, and routines can't write to its items; use report",
    )
    expect(problems(triage, rule('deliver: report'))).toEqual([])
  })

  it('needs a repo, and says routines is taken when a custom source has its name', () => {
    expect(problems('  routines:\n    tidy: { at: "09:00", title: Tidy }')).toEqual([
      'sources.routines.tidy.repo: required: the repo its work happens in',
    ])
    expect(problems('  routines: { command: ./items.sh }')).toEqual([
      'sources.routines.command: expected a routine with at, repo and title; routines is a built-in source, so give a custom one another name',
    ])
  })
})

describe('a routine in the plan', () => {
  const cfg = config(
    triage,
    'queue:\n  - { skill: triage, source: routines, where: { name: sentry-triage }, deliver: report }',
  )
  const planAt = async (now: string, attempts: Attempts = {}) => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(local(now))
    const items = await routines.items(cfg.sources.routines as RoutinesConfig, {
      env: {},
      log: () => {},
    })
    const plan = planRun({
      config: cfg,
      items,
      allowances: {},
      skills: { builtin: builtinSkills },
      attempts,
    })
    return {
      ...plan,
      routines: nextOccurrences(cfg.sources.routines as RoutinesConfig, new Date()),
    }
  }

  it('is planned once, not again after an attempt, and again at the next occurrence', async () => {
    const first = await planAt('2026-10-26T10:00')
    expect(first.units.map((p) => p.unit.id)).toEqual(['sentry-triage-20261026-0900'])
    const attempts: Attempts = {
      'routines:sentry-triage-20261026-0900': {
        runId: '20261026-100000',
        skill: 'triage',
        updated: '2026-10-26T08:00:00.000Z',
      },
    }
    const later = await planAt('2026-10-30T10:00', attempts)
    expect(later.units).toEqual([])
    expect(later.skipped).toMatchObject([
      { kind: 'unchanged', reason: 'unchanged since run 20261026-100000' },
    ])
    const next = await planAt('2026-11-02T09:00', attempts)
    expect(next.units.map((p) => p.unit.id)).toEqual(['sentry-triage-20261102-0900'])
  })

  it('says which occurrence an item is, and when the next one is', async () => {
    const plan = await planAt('2026-10-28T12:00')
    const item = plan.units[0]?.unit.items[0]
    if (!item) throw new Error('no unit')
    expect(formatWhy(plan, item).split('\n').slice(0, 3)).toEqual([
      "routines sentry-triage-20261026-0900  Triage last week's Sentry issues",
      '  https://github.com/acme/api',
      '  routine sentry-triage, due mon 2026-10-26 09:00; next mon 2026-11-02 09:00',
    ])
  })
})
