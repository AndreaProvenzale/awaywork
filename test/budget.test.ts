import { describe, expect, it } from 'vitest'
import type { Budget } from '../src/config/schema.js'
import { type Allowance, allowance, quotaFacts, route, withQuota } from '../src/core/budget.js'
import type { Quota } from '../src/core/types.js'

// Thursday at 01:00 local time, as the default window opens.
const now = new Date(2026, 0, 1, 1).getTime()
const daily = [{ start: '01:00', end: '07:00' }]
const hours = (h: number) => now / 1000 + h * 3600
const budget = (over: Partial<Budget> = {}): Budget => ({
  reserve: 0.1,
  session_max: 0.9,
  present_session_max: 0.4,
  fallback: { units: 4, turns: 60 },
  ...over,
})
const quota = (used: number, resetsInHours: number, session = 0.02): Quota => ({
  windows: [
    { name: 'five_hour', span: 'short', used: session, resetsAt: hours(3) },
    { name: 'seven_day', span: 'long', used, resetsAt: hours(resetsInHours) },
  ],
})
const ceiling = (a: Allowance) => (a.kind === 'quota' ? Math.round(a.ceiling * 1000) / 1000 : a)

describe('allowance', () => {
  it.each([
    ['per_run binds early in the week', budget({ per_run: 0.15 }), quota(0.36, 60), 0.51],
    ['pacing binds without per_run', budget(), quota(0.36, 60), 0.579],
    ['pacing on day 3 of 7', budget(), quota(0.2, 96), 0.386],
    ['pacing starts at 0 at the window start', budget(), quota(0, 168), 0],
    ['pacing reaches 1 - reserve at the reset', budget(), quota(0.36, 0), 0.9],
    ['a bigger reserve lowers every limit', budget({ reserve: 0.3 }), quota(0.36, 10), 0.658],
    ['past the line the ceiling sits below used', budget(), quota(0.7, 60), 0.579],
    ['a reset already past clamps to 1 - reserve', budget(), quota(0.36, -5), 0.9],
    ['a reset further than the window clamps to 0', budget(), quota(0, 200), 0],
  ])('%s', (_, b, q, expected) => {
    expect(ceiling(allowance(b, q, now, daily))).toBe(expected)
  })

  it("paces over the long window's length, a week when the quota doesn't say", () => {
    const month = (minutes?: number): Quota => ({
      windows: [{ name: '30d', span: 'long', used: 0, resetsAt: hours(15 * 24), minutes }],
    })
    expect(ceiling(allowance(budget(), month(30 * 24 * 60), now, daily))).toBe(0.45)
    expect(ceiling(allowance(budget(), month(), now, daily))).toBe(0)
  })

  it('paces over time, whatever the windows', () => {
    const weekly = [{ days: ['sat' as const], start: '10:00', end: '18:00' }]
    expect(ceiling(allowance(budget(), quota(0.36, 60), now, weekly))).toBe(0.579)
    expect(ceiling(allowance(budget(), quota(0.36, 60), now, []))).toBe(0.579)
  })

  it('counts the runs to the reset, the one under way included, at least one', () => {
    expect(allowance(budget(), quota(0.2, 60), now, daily)).toMatchObject({ runs: 3 })
    expect(allowance(budget(), quota(0.2, -1), now, daily)).toMatchObject({ runs: 1 })
  })

  it('counts only the windows that open before the reset', () => {
    const noon = now + 11 * 3600 * 1000
    // 61 hours from noon is 01:00 on Sunday: Friday's and Saturday's windows open before it, Sunday's doesn't.
    expect(allowance(budget(), quota(0.2, 72), noon, daily)).toMatchObject({ runs: 2 })
  })

  it('carries the session stop', () => {
    expect(allowance(budget({ session_max: 0.8 }), quota(0.2, 60, 0.4), now, daily)).toMatchObject({
      session: { used: 0.4, stopAt: 0.8, limit: 'session_max' },
    })
  })

  it('stops a present run at present_session_max', () => {
    expect(allowance(budget(), quota(0.2, 60, 0.3), now, daily, { present: true })).toMatchObject({
      session: { used: 0.3, stopAt: 0.4, limit: 'present_session_max' },
    })
  })

  it('falls back without a long window', () => {
    expect(allowance(budget(), null, now, daily, { reason: 'probe failed: boom' })).toEqual({
      kind: 'fallback',
      units: 4,
      turns: 60,
      reason: 'probe failed: boom',
    })
  })
})

describe('route', () => {
  const allowances = {
    full: allowance(budget(), quota(0.95, 60), now, daily),
    open: allowance(budget(), quota(0.2, 60), now, daily),
    capped: allowance(budget({ fallback: { units: 1, turns: 10 } }), null, now, daily),
  }

  it('takes the first candidate under its ceiling and says why others passed', () => {
    expect(route(['full', 'open'], allowances, {})).toEqual({
      provider: 'open',
      passed: ['full at its ceiling (95% of 57.9%)'],
    })
  })

  it('passes over a provider with no allowance, which is unavailable here', () => {
    expect(route(['gone', 'open'], allowances, {})).toEqual({
      provider: 'open',
      passed: ['gone unavailable'],
    })
  })

  it('caps fallback providers by units already routed', () => {
    expect(route(['capped'], allowances, {})).toEqual({ provider: 'capped', passed: [] })
    expect(route(['capped'], allowances, { capped: 1 })).toEqual({
      passed: ['capped used its 1 fallback unit'],
    })
  })

  describe('in a present run', () => {
    const present = { present: true }
    const presentAllowances = {
      busy: allowance(budget(), quota(0.2, 60, 0.5), now, daily, present),
      unread: allowance(budget(), null, now, daily, present),
      open: allowance(budget(), quota(0.2, 60, 0.1), now, daily, present),
    }

    it('passes over a provider past present_session_max', () => {
      expect(route(['busy', 'open'], presentAllowances, {})).toEqual({
        provider: 'open',
        passed: ['busy at present_session_max (50% of 40%)'],
      })
    })

    it('routes around a provider without a quota reading', () => {
      expect(route(['unread', 'open'], presentAllowances, {})).toEqual({
        provider: 'open',
        passed: ['unread has no quota reading, which a present run needs'],
      })
    })

    it('leaves an away run at session_max, with its fallback', () => {
      const busy = allowance(budget(), quota(0.2, 60, 0.5), now, daily)
      expect(route(['busy', 'capped'], { busy, capped: allowances.capped }, {})).toEqual({
        provider: 'busy',
        passed: [],
      })
      expect(route(['capped'], allowances, {})).toEqual({ provider: 'capped', passed: [] })
    })
  })
})

describe('quotaFacts', () => {
  it('reads runs and the headroom under the ceiling', () => {
    const a = allowance(budget(), quota(0.36, 10), now, daily)
    expect(quotaFacts(a).runs).toBe(1)
    expect(quotaFacts(a).headroom).toBeCloseTo(0.486)
  })

  it('rounds headroom to 0.1% so a value on the edge holds', () => {
    const a = { ...allowance(budget(), quota(0.1, 10), now, daily), ceiling: 0.3 }
    expect(quotaFacts(a).headroom).toBeGreaterThanOrEqual(0.2)
  })

  it('has headroom 0 past the ceiling and nothing on a fallback', () => {
    expect(quotaFacts(allowance(budget(), quota(0.95, 60), now, daily)).headroom).toBe(0)
    expect(quotaFacts(allowance(budget(), null, now, daily))).toEqual({})
  })
})

it('moves usage and the reset time to the last reading', () => {
  const next = withQuota(allowance(budget(), quota(0.1, 10), now, daily), quota(0.2, 20))
  expect(next).toMatchObject({ used: 0.2, resetsAt: hours(20) })
})
