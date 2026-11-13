import type { Item } from '../core/types.js'
import type { PlannedUnit, RunPlan } from '../plan/foreman.js'
import { needsYouOn, type ReportedSkip, type RunReport } from '../posts/report.js'

export const itemRef = ({ source, key, title, url }: Item) => ({ source, key, title, url })
const skippedRef = (item: Item) => ({ ...itemRef(item), type: item.type, mine: item.mine })

/** Drops an item's raw payload, and names a task's card by reference: the card is in the plan on its own. */
function lean(key: string, value: unknown) {
  if (key === 'raw') return undefined
  if (key !== 'task') return value
  const task = value as NonNullable<Item['task']>
  return { ...task, parent: itemRef(task.parent) }
}

/** Flags a skip you can act on, so a reader needn't know which kinds those are. */
const flagged = (s: ReportedSkip) => (needsYouOn(s) ? { ...s, needsYou: true } : s)

/** The plan and warnings as JSON; items drop their raw source payload. */
export function planJson(plan: RunPlan, warnings: string[] = []): string {
  return JSON.stringify({ ...plan, skipped: plan.skipped.map(flagged), warnings }, lean, 2)
}
const withItemRefs = (p: PlannedUnit) => ({
  ...p,
  unit: { ...p.unit, items: p.unit.items.map(itemRef) },
})

/** The run's results and warnings as JSON; items keep only what `formatReport` shows of them, a skipped one its `type` and `mine` too. */
export function reportJson(report: RunReport, warnings: string[] = []): string {
  const { plan, results } = report
  return JSON.stringify(
    {
      ...report,
      plan: {
        ...plan,
        units: plan.units.map(withItemRefs),
        skipped: plan.skipped.map(flagged).map((s) => ({ ...s, item: skippedRef(s.item) })),
      },
      results: results.map((r) => ({ ...r, planned: withItemRefs(r.planned) })),
      warnings,
    },
    null,
    2,
  )
}
