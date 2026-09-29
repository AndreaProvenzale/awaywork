import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
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

/** Attempts plus the items of every unit whose worker finished; a stopped or failed unit retries. */
export function recordAttempts(attempts: Attempts, report: NightReport): Attempts {
  const next = { ...attempts }
  for (const result of report.results.filter((r) => r.status === 'done'))
    for (const item of result.planned.unit.items)
      if (typeof item.fields.updated === 'string')
        next[attemptKey(item)] = { runId: report.runId, updated: item.fields.updated }
  return next
}

function attemptKey(item: Item): string {
  return `${item.source}:${item.key}`
}
