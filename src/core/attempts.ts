import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { UnitResult } from './report.js'
import type { Item } from './types.js'

export const MAX_ATTEMPTS = 3

/** Failed attempts per item, since the item last changed. */
export type Attempts = Record<string, { version: string; failed: number }>

const itemId = (item: Item) => `${item.source} ${item.key}`

/** Changes whenever the item does: its `updated` time, else a hash of what a worker reads. */
export function itemVersion(item: Item): string {
  const { updated } = item.fields
  if (typeof updated === 'string') return updated
  const read = [item.title, item.description, item.status, item.labels, item.comments]
  return createHash('sha256').update(JSON.stringify(read)).digest('hex').slice(0, 16)
}

/** Failed attempts on an item as it is now. */
export function failedAttempts(attempts: Attempts, item: Item): number {
  const entry = attempts[itemId(item)]
  return entry?.version === itemVersion(item) ? entry.failed : 0
}

/** Counts a unit that ran without a draft PR or a report against each of its items; a delivery clears them. */
export function recordAttempts(attempts: Attempts, results: UnitResult[]): Attempts {
  const next = { ...attempts }
  for (const r of results) {
    if (r.status === 'skipped' || r.status === 'prepared' || r.status === 'stopped: aborted')
      continue
    const delivered = r.outcome?.kind === 'pr' || r.outcome?.kind === 'report'
    for (const item of r.planned.unit.items) {
      if (delivered) delete next[itemId(item)]
      else
        next[itemId(item)] = {
          version: itemVersion(item),
          failed: failedAttempts(attempts, item) + 1,
        }
    }
  }
  return next
}

export async function loadAttempts(file: string): Promise<Attempts> {
  const text = await readFile(file, 'utf8').catch(() => '{}')
  return JSON.parse(text) as Attempts
}

export async function saveAttempts(file: string, attempts: Attempts): Promise<void> {
  await mkdir(dirname(file), { recursive: true })
  await writeFile(file, `${JSON.stringify(attempts, null, 2)}\n`)
}
