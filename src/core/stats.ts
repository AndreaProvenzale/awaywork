import type { UnitResult } from './report.js'

/** What a unit cost and delivered, as kept in its run's `units.json`. */
export interface UnitStat {
  id: string
  /** The rule's position in the queue that night. */
  rule: number
  skill: string
  provider?: string
  status: 'done' | 'failed' | 'stopped'
  /** Share of the long window used after the first reading; unknown when it reset in between. */
  used?: number
  pr: boolean
}

export interface StatsRow {
  units: number
  done: number
  failed: number
  stopped: number
  /** Sum of the shares used; undefined when no unit read the quota. */
  used?: number
  prs: number
}

/** The units that ran, not the skipped or prepared ones. */
export function unitStats(results: UnitResult[]): UnitStat[] {
  return results.flatMap((u) => {
    if (u.status === 'skipped' || u.status === 'prepared') return []
    const { unit } = u.planned
    const status =
      u.status === 'done' ? 'done' : u.status.startsWith('stopped') ? 'stopped' : 'failed'
    const first = u.firstQuota?.windows.find((w) => w.span === 'long')
    const last = u.quota?.windows.find((w) => w.name === first?.name)
    const sameWindow = first && last && first.resetsAt === last.resetsAt
    return [
      {
        id: unit.id,
        rule: u.planned.rule + 1,
        skill: unit.skill,
        provider: u.provider,
        status,
        used: sameWindow ? Math.max(0, last.used - first.used) : undefined,
        pr: u.outcome?.kind === 'pr',
      },
    ]
  })
}

/** Totals per value of `key`, in order of first appearance. */
export function tally(stats: UnitStat[], key: (s: UnitStat) => string): Record<string, StatsRow> {
  const rows: Record<string, StatsRow> = {}
  for (const s of stats) {
    const name = key(s)
    const row = rows[name] ?? { units: 0, done: 0, failed: 0, stopped: 0, prs: 0 }
    rows[name] = row
    row.units++
    row[s.status]++
    if (s.pr) row.prs++
    if (s.used !== undefined) row.used = (row.used ?? 0) + s.used
  }
  return rows
}
