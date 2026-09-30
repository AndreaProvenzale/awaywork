import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { PlannedUnit } from './foreman.js'
import type { NightReport, UnitResult } from './report.js'
import type { Item } from './types.js'

export const MAX_ATTEMPTS = 3

/**
 * Per item (`source:key`), the run that last attempted it, its skill, and the item's updated time
 * then; `failed` counts the attempts in a row that didn't finish, absent once one did.
 */
export type Attempts = Record<
  string,
  { runId: string; skill: string; updated: string; failed?: number }
>

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
  return last?.skill === skill && item.fields.updated === last.updated && !last.failed
    ? last.runId
    : undefined
}

/** Attempts in a row that didn't finish, on the item as it is now and with this skill. */
export function failedAttempts(item: Item, skill: string, attempts: Attempts): number {
  const last = attempts[attemptKey(item)]
  return last?.skill === skill && item.fields.updated === last.updated ? (last.failed ?? 0) : 0
}

/**
 * Attempts plus the items of every chain that ran: finished when its unit and `then` steps
 * were each done, up to the end or to a unit that made nothing. A stopped or failed unit, or
 * work left unpublished, retries its chain and counts one failure; a unit that didn't run
 * (skipped, a dry run, aborted) counts nothing; a step whose `when` didn't hold is passed
 * over. A loop counts through its host, which holds the loop's draft PR: its rounds don't
 * count on their own. An interrupted loop counts nothing, like an aborted unit, and so does
 * a host that kept its report when its last round didn't run.
 */
export function recordAttempts(attempts: Attempts, report: NightReport): Attempts {
  const next = { ...attempts }
  const result = (id: string) => report.results.find((r) => r.planned.unit.id === id)
  const step = (id: string) => report.plan.units.find((p) => p.after === id)
  for (const head of report.plan.units.filter((p) => !p.after && !p.loop)) {
    let at: PlannedUnit | undefined = head
    let short: UnitResult | undefined
    let finished = true
    while (at) {
      const r = result(at.unit.id)
      if (r?.passedOver) {
        at = step(at.unit.id)
        continue
      }
      if (r?.status !== 'done' || (r.outcome?.kind === 'none' && r.outcome.unpublished)) {
        finished = false
        short = r
      }
      at = finished && (r?.outcome?.kind ?? 'none') !== 'none' ? step(at.unit.id) : undefined
    }
    // A kept report its loop left unpublished (`loop …`) counts by the round the loop ended on:
    // one that didn't run counts nothing, as a plain chain's step.
    const unfinished = short?.outcome?.kind === 'none' && short.outcome.reason.startsWith('loop ')
    const ended = unfinished
      ? (report.results.findLast((r) => r.planned.loop?.host === short?.planned.unit.id) ?? short)
      : short
    if (!finished && (!ran(short) || !ran(ended))) continue
    const { skill } = head.unit
    for (const item of head.unit.items)
      if (typeof item.fields.updated === 'string')
        next[attemptKey(item)] = {
          runId: report.runId,
          skill,
          updated: item.fields.updated,
          ...(!finished && { failed: failedAttempts(item, skill, attempts) + 1 }),
        }
  }
  return next
}

function ran(r: UnitResult | undefined): boolean {
  if (r?.outcome?.kind === 'none' && r.outcome.reason === 'interrupted') return false
  return !!r && r.status !== 'skipped' && r.status !== 'prepared' && r.status !== 'stopped: aborted'
}

function attemptKey(item: Item): string {
  return `${item.source}:${item.key}`
}
