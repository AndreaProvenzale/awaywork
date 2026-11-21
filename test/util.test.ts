import type { ChildProcess } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { afterEach, expect, it, vi } from 'vitest'
import { parseJson } from '#util/json'
import { killGroupSoon } from '#util/process'
import { errorText } from '#util/text'

it('parses JSON, or gives undefined for empty or broken text', () => {
  expect(parseJson('{"a":1}')).toEqual({ a: 1 })
  expect(parseJson('null')).toBeNull()
  expect(parseJson('')).toBeUndefined()
  expect(parseJson('{"a"')).toBeUndefined()
})

it("gives an error's message, or anything else thrown as a string", () => {
  expect(errorText(new Error('boom'))).toBe('boom')
  expect(errorText('plain')).toBe('plain')
  expect(errorText(undefined)).toBe('undefined')
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

function fakeChild(exitCode: number | null) {
  const nodeChildProcess = Object.assign(new EventEmitter(), {
    exitCode,
    signalCode: null,
  }) as unknown as ChildProcess
  return { pid: 4242, nodeChildProcess }
}

it('kills the group a grace after the result while the child runs, not after it exited', () => {
  vi.useFakeTimers()
  const kill = vi.spyOn(process, 'kill').mockImplementation(() => true)
  killGroupSoon(fakeChild(0))
  vi.advanceTimersByTime(10_000)
  expect(kill).not.toHaveBeenCalled()
  killGroupSoon(fakeChild(null))
  vi.advanceTimersByTime(10_000)
  expect(kill).toHaveBeenCalledWith(-4242, 'SIGKILL')
})
