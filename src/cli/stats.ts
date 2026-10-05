import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Command } from 'commander'
import { runsDir } from '../config/paths.js'
import { pct } from '../core/budget.js'
import { type StatsRow, tally, type UnitStat } from '../core/stats.js'

export const unitsFile = 'units.json'

export function statsCommand(program: Command): void {
  program
    .command('stats')
    .description('what each rule, skill and provider cost and delivered across all runs')
    .option('--json', 'print the totals as JSON')
    .action(async (opts: { json?: boolean }) => {
      const stats = await loadStats(runsDir)
      console.log(formatStats(stats, !!opts.json))
    })
}

/** The units of every run that kept a `units.json`; older runs have none. */
export async function loadStats(dir: string): Promise<UnitStat[]> {
  const runs = (await readdir(dir).catch(() => [])).sort()
  const lists = await Promise.all(
    runs.map(async (run) => {
      try {
        return JSON.parse(await readFile(join(dir, run, unitsFile), 'utf8')) as UnitStat[]
      } catch {
        return []
      }
    }),
  )
  return lists.flat()
}

export function formatStats(stats: UnitStat[], json: boolean): string {
  const groups = {
    rule: tally(stats, (s) => `#${s.rule} ${s.skill}`),
    skill: tally(stats, (s) => s.skill),
    provider: tally(stats, (s) => s.provider ?? '-'),
  }
  if (json) return JSON.stringify(groups, null, 2)
  if (stats.length === 0) return 'No runs with stats yet'
  return Object.entries(groups)
    .map(([name, rows]) => table(name, rows))
    .join('\n\n')
}

function table(name: string, rows: Record<string, StatsRow>): string {
  const head = [name, 'units', 'done', 'failed', 'stopped', 'quota', 'PRs']
  const body = Object.entries(rows).map(([key, r]) => [
    key,
    r.units,
    r.done,
    r.failed,
    r.stopped,
    r.used === undefined ? '-' : pct(r.used),
    r.prs,
  ])
  const cells = [head, ...body].map((row) => row.map(String))
  const widths = head.map((_, i) => Math.max(...cells.map((row) => (row[i] as string).length)))
  return cells
    .map((row) =>
      row
        .map((c, i) => c.padEnd(widths[i] as number))
        .join('  ')
        .trimEnd(),
    )
    .join('\n')
}
