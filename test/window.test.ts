import { expect, it } from 'vitest'
import { nightEnd } from '../src/core/window.js'

const at = (day: number, time: string) => new Date(`2026-09-${day}T${time}:00`)

it.each([
  ['01:00', '07:00', at(25, '00:59'), undefined],
  ['01:00', '07:00', at(25, '01:00'), at(25, '07:00')],
  ['01:00', '07:00', at(25, '06:59'), at(25, '07:00')],
  ['01:00', '07:00', at(25, '07:00'), undefined],
  ['23:00', '06:00', at(25, '23:30'), at(26, '06:00')],
  ['23:00', '06:00', at(26, '02:00'), at(26, '06:00')],
  ['23:00', '06:00', at(26, '12:00'), undefined],
])('%s-%s at %s ends at %s', (start, end, now, until) => {
  expect(nightEnd({ start, end }, now)).toEqual(until)
})
