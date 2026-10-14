import { expect, it } from 'vitest'
import { runEnd, runsLeft, startsOf, tooLongForHosted, windowEnd } from '../src/core/window.js'

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
  expect(windowEnd([{ start, end }], now)).toEqual(until)
})

const windows = [
  { start: '01:00', end: '07:00' },
  { days: ['sat' as const, 'sun' as const], start: '10:00', end: '18:00' },
]

it('ends a weekday window only on its days', () => {
  // 2026-09-26 is a Saturday
  expect(windowEnd(windows, at(26, '11:00'))).toEqual(at(26, '18:00'))
  expect(windowEnd(windows, at(25, '11:00'))).toBeUndefined()
  expect(windowEnd(windows, at(25, '02:00'))).toEqual(at(25, '07:00'))
})

it('gives a window that crosses midnight to the day it opened', () => {
  const late = [{ days: ['sat' as const], start: '22:00', end: '02:00' }]
  expect(windowEnd(late, at(26, '23:00'))).toEqual(at(27, '02:00'))
  expect(windowEnd(late, at(27, '01:30'))).toEqual(at(27, '02:00'))
  expect(windowEnd(late, at(28, '01:30'))).toBeUndefined()
})

it('stops a run on a GitHub-hosted runner 5h40 in, or at the window end when that comes first', () => {
  const hosted = { RUNNER_ENVIRONMENT: 'github-hosted' }
  const long = [{ start: '18:00', end: '07:00' }]
  expect(runEnd(long, at(25, '18:02'), hosted)).toEqual(at(25, '23:42'))
  expect(runEnd(long, at(26, '05:00'), hosted)).toEqual(at(26, '07:00'))
  expect(runEnd(long, at(25, '12:00'), hosted)).toBeUndefined()
  expect(runEnd(long, at(25, '18:02'), { RUNNER_ENVIRONMENT: 'self-hosted' })).toEqual(
    at(26, '07:00'),
  )
  expect(runEnd(long, at(25, '18:02'), {})).toEqual(at(26, '07:00'))
})

it('finds the windows longer than a GitHub-hosted job', () => {
  const six = { start: '01:00', end: '07:00' }
  const thirteen = { start: '18:00', end: '07:00' }
  expect(tooLongForHosted([six, thirteen, { start: '09:00', end: '15:01' }])).toEqual([
    thirteen,
    { start: '09:00', end: '15:01' },
  ])
})

it('counts the windows left before a reset', () => {
  const ms = (day: number, time: string) => at(day, time).getTime()
  expect(runsLeft([{ start: '01:00', end: '07:00' }], ms(25, '12:00'), ms(28, '12:00'))).toBe(3)
  // Fri noon to Mon noon: the 01:00 windows of Sat, Sun and Mon plus the Saturday and Sunday day windows
  expect(runsLeft(windows, ms(25, '12:00'), ms(28, '12:00'))).toBe(5)
  expect(runsLeft(windows, ms(26, '11:00'), ms(26, '11:30'))).toBe(1)
  expect(runsLeft(windows, ms(25, '12:00'), ms(25, '12:30'))).toBe(1)
})

it('merges windows opening at the same time into one start, as launchd reads them back', () => {
  const windows = [
    { start: '10:00', end: '11:00', days: ['wed' as const] },
    { start: '10:00', end: '11:00', days: ['mon' as const] },
    { start: '01:00', end: '07:00' },
  ]
  expect(startsOf(windows)).toEqual([
    { hour: 10, minute: 0, days: [1, 3] },
    { hour: 1, minute: 0 },
  ])
})
