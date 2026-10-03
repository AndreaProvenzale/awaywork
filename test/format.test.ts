import { describe, expect, it } from 'vitest'
import { describeRule, statusMarker } from '../src/cli/format.js'
import { parseConfig } from '../src/config/load.js'
import type { Rule } from '../src/core/types.js'

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

describe('describeRule', () => {
  it('lists the where keys in order, with any last and its entries split by |', () => {
    const cfg = parseConfig(`
providers: [claude: {}]
sources: { github: { repos: [acme/api] } }
queue:
  - skill: fix-ci
    where: { type: pr, any: [{ checks: failing, label: urgent }, { any: [{ mine: true }] }], draft: false }
`)
    expect(describeRule(cfg.queue?.[0] as Rule)).toBe(
      'type=pr draft=false any(checks=failing label=urgent | any(mine=true))',
    )
  })
})
