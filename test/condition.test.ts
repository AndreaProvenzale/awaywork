import { expect, it } from 'vitest'
import { describeCondition, holds } from '../src/core/condition.js'

it('holds a quota condition against nights and headroom, and fails without a reading', () => {
  const when = { nights_until_reset: 1, headroom: 0.2 }
  expect(holds(when, { nights: 1, headroom: 0.2 })).toBe(true)
  expect(holds(when, { nights: 2, headroom: 0.5 })).toBe(false)
  expect(holds(when, { nights: 1, headroom: 0.1 })).toBe(false)
  expect(holds(when, {})).toBe(false)
})

it('describes a quota condition', () => {
  expect(describeCondition({ nights_until_reset: 1, headroom: 0.2 })).toBe(
    "the window resets within 1 night and at least 20% is left under tonight's ceiling",
  )
})
