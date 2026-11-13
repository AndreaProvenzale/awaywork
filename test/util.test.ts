import { expect, it } from 'vitest'
import { parseJson } from '../src/util/json.js'
import { errorText } from '../src/util/text.js'

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
