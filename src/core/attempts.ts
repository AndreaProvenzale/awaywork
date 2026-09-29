import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { PlannedUnit } from './foreman.js'
import type { NightReport } from './report.js'
import type { Item } from './types.js'

/** Per item (`source:key`), the run that last finished work on it, its skill, and the item's updated time then. */
export type Attempts = Record<string, { runId: string; skill: string; updated: string }>

export async function loadAttempts(path: string): Promise<Attempts> {
  const text = await readFile(path, 'utf8').catch(() => '{}')
  try {
    return JSON.parse(text) as Attempts
  } catch {
    return {}
  }
}

export async function saveAttempts(path: string, attempts: Attempts): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(`${path}.tmp`, `${JSON.stringify(attempts, null, 2)}\n`)
  await rename(`${path}.tmp`, path)
}

/** The run that last attempted the item with this skill, when the item hasn't been updated since. */
export function unchangedSince(item: Item, skill: string, attempts: Attempts): string | undefined {
  const last = attempts[attemptKey(item)]
  return last?.skill === skill && item.fields.updated === last.updated ? last.runId : undefined
}

/**
 * Attempts plus the items of every finished chain: a unit and its `then` steps, each done,
 * up to the end or to a unit that made nothing. A stopped or failed unit, or work left
 * unpublished, retries its chain.
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
      if (r?.status !== 'done' || (r.outcome?.kind === 'none' && r.outcome.unpublished))
        finished = false
      at = finished && (r?.outcome?.kind ?? 'none') !== 'none' ? step(at.unit.id) : undefined
    }
    if (!finished) continue
    for (const item of head.unit.items)
      if (typeof item.fields.updated === 'string')
        next[attemptKey(item)] = {
          runId: report.runId,
          skill: head.unit.skill,
          updated: item.fields.updated,
        }
  }
  return next
}

function attemptKey(item: Item): string {
  return `${item.source}:${item.key}`
}
