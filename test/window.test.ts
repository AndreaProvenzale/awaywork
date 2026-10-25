import { expect, it } from 'vitest'
import {
  hostedEnd,
  nextOpening,
  runEnd,
  runsLeft,
  startsOf,
  tooLongForHosted,
  type Window,
  windowEnd,
} from '../src/core/window.js'

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

it('caps any run on a GitHub-hosted runner, scheduled or not', () => {
  expect(hostedEnd(at(25, '12:00'), { RUNNER_ENVIRONMENT: 'github-hosted' })).toEqual(
    at(25, '17:40'),
  )
  expect(hostedEnd(at(25, '12:00'), { RUNNER_ENVIRONMENT: 'self-hosted' })).toBeUndefined()
  expect(hostedEnd(at(25, '12:00'), {})).toBeUndefined()
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

it("finds a run's next turn after the end of the window it is in, or of the next one to open", () => {
  const ms = (day: number, time: string) => at(day, time).getTime()
  const next = (windows: Window[], day: number, time: string) =>
    nextOpening(windows, ms(day, time), ms(day, time) + 30 * 86_400_000)
  const night = [{ start: '22:00', end: '06:00' }]
  expect(next(night, 25, '22:00')).toBe(ms(26, '22:00'))
  expect(next(night, 26, '01:00')).toBe(ms(26, '22:00'))
  expect(next(night, 25, '12:00')).toBe(ms(26, '22:00'))
  // 2026-09-26 is a Saturday
  expect(next(windows, 26, '11:00')).toBe(ms(27, '01:00'))
  const weekend = [{ days: ['sat' as const, 'sun' as const], start: '10:00', end: '18:00' }]
  expect(next(weekend, 26, '10:00')).toBe(ms(27, '10:00'))
  expect(next(weekend, 27, '10:00')).toBe(at(26, '10:00').getTime() + 7 * 86_400_000)
  expect(next([...windows, { start: '03:00', end: '05:00' }], 25, '01:00')).toBe(ms(26, '01:00'))
  expect(
    next(
      [
        { start: '01:00', end: '03:00' },
        { start: '03:00', end: '05:00' },
      ],
      25,
      '01:00',
    ),
  ).toBe(ms(25, '03:00'))
  expect(nextOpening(night, ms(25, '22:00'), ms(26, '22:00'))).toBeUndefined()
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
