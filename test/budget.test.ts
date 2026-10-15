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
    ['pacing binds without per_run', budget(), quota(0.36, 60), 0.54],
    ['the last run may spend up to the reserve', budget(), quota(0.36, 10), 0.9],
    ['a bigger reserve lowers every limit', budget({ reserve: 0.3 }), quota(0.36, 10), 0.7],
    ['past the reserve the ceiling sits below used', budget(), quota(0.95, 60), 0.9],
  ])('%s', (_, b, q, expected) => {
    expect(ceiling(allowance(b, q, now, daily))).toBe(expected)
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
      session: { used: 0.4, stopAt: 0.8 },
    })
  })

  it('falls back without a long window', () => {
    expect(allowance(budget(), null, now, daily, 'probe failed: boom')).toEqual({
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
      passed: ['full at its ceiling (95% of 90%)'],
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
      passed: ['capped used its 1 fallback units'],
    })
  })
})

describe('quotaFacts', () => {
  it('reads runs and the headroom under the ceiling', () => {
    const a = allowance(budget(), quota(0.36, 10), now, daily)
    expect(quotaFacts(a).runs).toBe(1)
    expect(quotaFacts(a).headroom).toBeCloseTo(0.54)
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

it('paces over the windows left, not the days', () => {
  const weekly = [{ days: ['sat' as const], start: '10:00', end: '18:00' }]
  expect(ceiling(allowance(budget(), quota(0.36, 60), now, weekly))).toBe(0.9)
  expect(ceiling(allowance(budget(), quota(0.36, 60), now, daily))).toBe(0.54)
})

it('moves usage and the reset time to the last reading', () => {
  const next = withQuota(allowance(budget(), quota(0.1, 10), now, daily), quota(0.2, 20))
  expect(next).toMatchObject({ used: 0.2, resetsAt: hours(20) })
})
