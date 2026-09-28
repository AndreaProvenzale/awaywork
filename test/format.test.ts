import { describe, expect, it } from 'vitest'
import { statusMarker } from '../src/cli/format.js'

describe('statusMarker', () => {
  it('colors a glyph per status', () => {
    expect(statusMarker('ok', true)).toBe('\u001b[32m✔\u001b[39m')
    expect(statusMarker('warn', true)).toBe('\u001b[33m⚠\u001b[39m')
    expect(statusMarker('FAIL', true)).toBe('\u001b[31m✖\u001b[39m')
  })

  it('keeps the padded plain words without color', () => {
    expect(statusMarker('ok', false)).toBe('ok  ')
    expect(statusMarker('warn', false)).toBe('warn')
    expect(statusMarker('FAIL', false)).toBe('FAIL')
  })
})
