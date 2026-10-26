import { expect } from 'vitest'
import { markComment, planComment } from '../../src/core/footer.js'
import { planState, planYaml } from '../../src/core/plan.js'
import type { Item } from '../../src/core/types.js'

/** A plan.yml with what a tracker's rich text could mangle: indentation, a blank line, quotes, `#`, Markdown. */
export const roundTripYaml = `tasks:
  - id: api
    title: "VAT export: GET /exports/vat"
    description: |
      Add the endpoint, *paged* like \`/exports/sales\`.

      Keep <b>old</b> # routes and _names_.
  - id: web
    title: Export button # on the reports page
    after: { api: merged }
`

/** The plan comment awaywork writes, mark included, as a source's write gets it. */
export const roundTripComment = markComment(
  planComment('Two tasks: the **API** first, then the button.', roundTripYaml),
)

/** The item's newest comment reads back as the same plan, waiting for approval. */
export function expectPlanBack(item: Item | undefined): void {
  const newest = item?.comments.at(-1)
  expect(planYaml(newest?.body ?? '')).toBe(roundTripYaml.trim())
  expect(item && planState(item, { maxTasks: 8 })).toEqual({ state: 'waiting' })
}
