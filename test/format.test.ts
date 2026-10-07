import { describe, expect, it } from 'vitest'
import { describeRule, formatPlan, listedUnits, statusMarker } from '../src/cli/format.js'
import { parseConfig } from '../src/config/load.js'
import { allowance } from '../src/core/budget.js'
import { planNight } from '../src/core/foreman.js'
import { builtinSkills } from '../src/core/skills.js'
import type { Rule } from '../src/core/types.js'
import { githubPr } from './fakes/items.js'

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

describe('listedUnits', () => {
  it('lists only round 1 of a loop', () => {
    const unit = (loop?: { round: number }) => ({ loop })
    const units = [unit(), unit({ round: 1 }), unit({ round: 2 }), unit({ round: 3 })]
    expect(listedUnits({ units } as never)).toEqual([units[0], units[1]])
  })
})

describe('formatPlan', () => {
  it('says why a quota when fails on its when line', () => {
    const config = parseConfig(`
providers: [claude: {}]
sources: { github: { repos: [acme/api] } }
queue:
  - skill: fix-ci
    where: { checks: failing }
    when: { nights_until_reset: 1 }
`)
    const now = Date.UTC(2026, 0, 1, 1)
    const quota = {
      windows: [
        { name: 'seven_day', span: 'long' as const, used: 0.36, resetsAt: now / 1000 + 60 * 3600 },
      ],
    }
    const allowances = Object.fromEntries(
      config.providers.map((p) => [p.id, allowance(p.budget, quota, now)]),
    )
    const plan = planNight({
      config,
      items: [githubPr(1, { checks: 'failing' })],
      allowances,
      skills: { builtin: builtinSkills },
    })
    expect(formatPlan(plan)).toContain(
      "     when the window resets within 1 night (the quota part doesn't hold on the probe)\n",
    )
  })
})
