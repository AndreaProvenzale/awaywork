import { expect, it } from 'vitest'
import { describeCondition, holds } from '../src/core/condition.js'

it('holds a quota condition against runs and headroom, and fails without a reading', () => {
  const when = { runs_until_reset: 1, headroom: 0.2 }
  expect(holds(when, { runs: 1, headroom: 0.2 })).toBe(true)
  expect(holds(when, { runs: 2, headroom: 0.5 })).toBe(false)
  expect(holds(when, { runs: 1, headroom: 0.1 })).toBe(false)
  expect(holds(when, {})).toBe(false)
})

it('describes a quota condition', () => {
  expect(describeCondition({ runs_until_reset: 1, headroom: 0.2 })).toBe(
    "the window resets within 1 run and at least 20% is left under this run's ceiling",
  )
})
