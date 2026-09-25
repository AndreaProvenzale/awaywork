import { describe, expect, it } from 'vitest'
import type { Budget } from '../src/config/schema.js'
import { type Allowance, allowance, route } from '../src/core/budget.js'
import type { Quota } from '../src/core/types.js'

const now = Date.UTC(2026, 0, 1, 1)
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
    ['per_night binds early in the week', budget({ per_night: 0.15 }), quota(0.36, 60), 0.51],
    ['pacing binds without per_night', budget(), quota(0.36, 60), 0.54],
    ['the last night may spend up to the reserve', budget(), quota(0.36, 10), 0.9],
    ['a bigger reserve lowers every limit', budget({ reserve: 0.3 }), quota(0.36, 10), 0.7],
    ['past the reserve the ceiling sits below used', budget(), quota(0.95, 60), 0.9],
  ])('%s', (_, b, q, expected) => {
    expect(ceiling(allowance(b, q, now))).toBe(expected)
  })

  it('counts nights to the reset, at least one', () => {
    expect(allowance(budget(), quota(0.2, 60), now)).toMatchObject({ nights: 3 })
    expect(allowance(budget(), quota(0.2, -1), now)).toMatchObject({ nights: 1 })
  })

  it('carries the session stop', () => {
    expect(allowance(budget({ session_max: 0.8 }), quota(0.2, 60, 0.4), now)).toMatchObject({
      session: { used: 0.4, stopAt: 0.8 },
    })
  })

  it('falls back without a long window', () => {
    expect(allowance(budget(), null, now, 'probe failed: boom')).toEqual({
      kind: 'fallback',
      units: 4,
      turns: 60,
      reason: 'probe failed: boom',
    })
  })
})

describe('route', () => {
  const allowances = {
    full: allowance(budget(), quota(0.95, 60), now),
    open: allowance(budget(), quota(0.2, 60), now),
    capped: allowance(budget({ fallback: { units: 1, turns: 10 } }), null, now),
  }

  it('takes the first candidate under its ceiling and says why others passed', () => {
    expect(route(['full', 'open'], allowances, {})).toEqual({
      provider: 'open',
      passed: ['full at its ceiling (95% of 90%)'],
    })
  })

  it('caps fallback providers by units already routed', () => {
    expect(route(['capped'], allowances, {})).toEqual({ provider: 'capped', passed: [] })
    expect(route(['capped'], allowances, { capped: 1 })).toEqual({
      passed: ['capped used its 1 fallback units'],
    })
  })
})
