import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { chainResults, finished } from './attempts.js'
import type { RunReport } from './report.js'
import type { Item } from './types.js'

/** Per item, by `source:key`, with the time it was approved. */
export type Approvals = Record<string, { at: string }>

export async function loadApprovals(path: string): Promise<Approvals> {
  const text = await readFile(path, 'utf8').catch(() => '{}')
  try {
    return JSON.parse(text) as Approvals
  } catch {
    return {}
  }
}

export async function saveApprovals(path: string, approvals: Approvals): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(`${path}.tmp`, `${JSON.stringify(approvals, null, 2)}\n`)
  await rename(`${path}.tmp`, path)
}

/** The items with their `approved` field set, which a rule's `where` reads like any other. */
export function withApprovals(items: Item[], approvals: Approvals): Item[] {
  return items.map((item) => ({
    ...item,
    fields: { ...item.fields, approved: !!approvals[`${item.source}:${item.key}`] },
  }))
}

/** The approvals left once a chain on an item finished: it uses up the approval it was planned with, not one given during the run. */
export function clearApprovals(approvals: Approvals, report: RunReport): Approvals {
  const next = { ...approvals }
  for (const head of report.plan.units.filter((p) => !p.chain))
    if (finished(chainResults(report, head.unit.id)))
      for (const item of head.unit.items)
        if (item.fields.approved) delete next[`${item.source}:${item.key}`]
  return next
}
