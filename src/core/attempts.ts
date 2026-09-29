import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { PlannedUnit } from './foreman.js'
import type { NightReport } from './report.js'
import type { Item } from './types.js'

/** Per item (`source:key`), the run that last finished work on it and the item's updated time then. */
export type Attempts = Record<string, { runId: string; updated: string }>

export async function loadAttempts(path: string): Promise<Attempts> {
  const text = await readFile(path, 'utf8').catch(() => '{}')
  return JSON.parse(text) as Attempts
}

export async function saveAttempts(path: string, attempts: Attempts): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, `${JSON.stringify(attempts, null, 2)}\n`)
}

/** The run that last attempted the item, when the item hasn't been updated since. */
export function unchangedSince(item: Item, attempts: Attempts): string | undefined {
  const last = attempts[attemptKey(item)]
  return last && item.fields.updated === last.updated ? last.runId : undefined
}

/**
 * Attempts plus the items of every finished chain: a unit and its `then` steps, each done,
 * up to the end or to a unit that delivered nothing. A stopped or failed unit retries its chain.
 */
export function recordAttempts(attempts: Attempts, report: NightReport): Attempts {
  const next = { ...attempts }
  const result = (id: string) => report.results.find((r) => r.planned.unit.id === id)
  const step = (id: string) => report.plan.units.find((p) => p.after === id)
  for (const head of report.plan.units.filter((p) => !p.after)) {
    let at: PlannedUnit | undefined = head
    let finished = true
    while (at) {
      const r = result(at.unit.id)
      if (r?.status !== 'done') finished = false
      at = finished && (r?.outcome?.kind ?? 'none') !== 'none' ? step(at.unit.id) : undefined
    }
    if (!finished) continue
    for (const item of head.unit.items)
      if (typeof item.fields.updated === 'string')
        next[attemptKey(item)] = { runId: report.runId, updated: item.fields.updated }
  }
  return next
}

function attemptKey(item: Item): string {
  return `${item.source}:${item.key}`
}
