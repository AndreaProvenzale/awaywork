import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { RunReport, UnitResult } from './report.js'
import type { Item, PrRef } from './types.js'

export const MAX_ATTEMPTS = 3

/**
 * Per item (`source:key`), the run that last attempted it, its skill, and the item's updated time
 * then; `failed` counts the attempts in a row that didn't finish, absent once one did; `pushed` is
 * the head a `push` left on a PR branch.
 */
export type Attempts = Record<
  string,
  { runId: string; skill: string; updated: string; failed?: number; pushed?: string }
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

/** The PR a chain pushed onto, while its head is still the one the push left: it waits for you. */
export function pushedOnto(items: Item[], attempts: Attempts): PrRef | undefined {
  const heads = items.map((item) => attempts[attemptKey(item)]?.pushed)
  return items.flatMap((i) => i.linkedPrs).find((pr) => pr.head && heads.includes(pr.head))
}

/**
 * Attempts plus the items of every chain that ran: finished when each of its steps that ran was
 * done and no slice's publish left anything behind. A stopped or failed step, or work left
 * unpublished, retries the chain and counts one failure; a step that didn't run (skipped, a dry
 * run, aborted) counts nothing; a step passed over, by its `when` or after one that made
 * nothing, doesn't count.
 */
export function recordAttempts(attempts: Attempts, report: RunReport): Attempts {
  const next = { ...attempts }
  for (const head of report.plan.units.filter((p) => !p.chain)) {
    const id = head.unit.id
    const chain = report.results.filter((r) => r.planned.unit.id === id || r.planned.chain === id)
    // A rule's own `when` that didn't hold: the item is still waiting for it, not handled.
    if (chain[0]?.passedOver) continue
    // Each slice's outcome is on its first step.
    const push = chain.find((r) => r.outcome?.kind === 'pushed')?.outcome
    const pushed = push?.kind === 'pushed' ? push.head : undefined
    const short = chain.find((r) => !r.passedOver && r.status !== 'done')
    const unpublished = chain.find((r) => r.outcome?.kind === 'none' && r.outcome.unpublished)
    const finished = chain.length > 0 && !short && !unpublished
    // Work left unpublished is the chain's own failure, whatever a later step missed.
    const aborted = !finished && !ran(unpublished ?? short ?? chain[0])
    // A push stays recorded even when a step after it didn't run.
    if (aborted && !pushed) continue
    const { skill } = head.unit
    for (const item of head.unit.items) {
      if (typeof item.fields.updated !== 'string') continue
      const key = attemptKey(item)
      // Aborted after a push: only the push's head is new, and an empty `updated` never reads as unchanged.
      if (aborted) next[key] = { runId: report.runId, skill, updated: '', ...attempts[key], pushed }
      else
        next[key] = {
          runId: report.runId,
          skill,
          updated: item.fields.updated,
          ...(!finished && { failed: failedAttempts(item, skill, attempts) + 1 }),
          ...(pushed && { pushed }),
        }
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
