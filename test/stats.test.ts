import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { formatStats, loadStats } from '../src/cli/stats.js'
import type { UnitResult } from '../src/core/report.js'
import { tally, type UnitStat, unitStats } from '../src/core/stats.js'
import type { Quota } from '../src/core/types.js'

const quota = (used: number): Quota => ({
  windows: [
    { name: 'five_hour', span: 'short', used: 0.5, resetsAt: 0 },
    { name: 'seven_day', span: 'long', used, resetsAt: 0 },
  ],
})
const base = (used: number) => ({ name: 'seven_day', used, resetsAt: 0 })
const result = (over: Partial<UnitResult> & { skill?: string; rule?: number }): UnitResult =>
  ({
    planned: { rule: over.rule ?? 0, unit: { id: 'u', skill: over.skill ?? 'implement' } },
    provider: 'claude',
    status: 'done',
    ...over,
  }) as UnitResult

describe('unitStats', () => {
  it('measures the long window between the baseline and the last reading, and drops units that did not run', () => {
    const stats = unitStats([
      result({
        baseline: base(0.1),
        quota: quota(0.16),
        outcome: { kind: 'pr', url: 'u', commits: 1, head: 'h' },
      }),
      result({ status: 'stopped: quota' }),
      result({ status: 'skipped' }),
      result({ status: 'error' }),
    ])
    expect(stats.map((s) => [s.status, s.pr, s.rule])).toEqual([
      ['done', true, 1],
      ['stopped', false, 1],
      ['failed', false, 1],
    ])
    expect(stats[0]?.used).toBeCloseTo(0.06)
    expect(stats[1]?.used).toBeUndefined()
  })

  it('leaves the share unknown when the window reset between the readings', () => {
    const reset: Quota = {
      windows: [{ name: 'seven_day', span: 'long', used: 0.02, resetsAt: 1 }],
    }
    expect(unitStats([result({ baseline: base(0.9), quota: reset })])[0]?.used).toBeUndefined()
  })

  it('measures a unit that read the quota once, as Codex does', () => {
    expect(unitStats([result({ baseline: base(0.4), quota: quota(0.45) })])[0]?.used).toBeCloseTo(
      0.05,
    )
  })

  it('leaves the share unknown without a baseline or a reading', () => {
    expect(unitStats([result({ quota: quota(0.4) })])[0]?.used).toBeUndefined()
    expect(unitStats([result({ baseline: base(0.4) })])[0]?.used).toBeUndefined()
  })
})

describe('loadStats', () => {
  it('reads units.json per run and ignores missing, malformed or non-array files and entries of the wrong shape', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'awaywork-'))
    const unit = { id: 'a', rule: 1, skill: 'implement', status: 'done', pr: false }
    const files: Record<string, string | undefined> = {
      a: JSON.stringify([unit, { id: 'x' }, null, { ...unit, status: 'bogus' }]),
      b: undefined,
      c: '{not json',
      d: '{}',
    }
    for (const [run, content] of Object.entries(files)) {
      await mkdir(join(dir, run))
      if (content) await writeFile(join(dir, run, 'units.json'), content)
    }
    expect(await loadStats(dir)).toEqual([unit])
    expect(await loadStats(join(dir, 'missing'))).toEqual([])
  })
})

describe('stats output', () => {
  const stats: UnitStat[] = [
    {
      id: 'a',
      rule: 1,
      skill: 'implement',
      provider: 'claude',
      status: 'done',
      used: 0.05,
      pr: true,
    },
    {
      id: 'b',
      rule: 1,
      skill: 'implement',
      provider: 'claude',
      status: 'failed',
      used: 0.02,
      pr: false,
    },
    { id: 'c', rule: 2, skill: 'review', provider: 'codex', status: 'stopped', pr: false },
  ]

  it('totals per key', () => {
    expect(tally(stats, (s) => s.skill).implement).toEqual({
      units: 2,
      done: 1,
      failed: 1,
      stopped: 0,
      used: 0.07,
      prs: 1,
    })
  })

  it('prints tables and JSON', () => {
    expect(formatStats(stats, false)).toContain(
      '#2 review     1      0     0       1        -      0',
    )
    expect(Object.keys(JSON.parse(formatStats(stats, true)))).toEqual(['rule', 'skill', 'provider'])
    expect(formatStats([], false)).toBe('No runs with stats yet')
  })
})
