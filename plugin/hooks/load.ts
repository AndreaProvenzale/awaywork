import type { EngineInterface } from 'claude-code'
import { atom, update } from 'claude-code'

import type { Data, Plan, Report, View } from '../types'
import { acts, onKnownConfig, PLAN_TIMEOUT } from './actions'
import { json } from './cli'

const data = atom({ plugin: 'awaywork', key: 'data' } as const, {} as Data, { shape: 'data-2' })
const view = atom({ plugin: 'awaywork', key: 'view' } as const, {} as View, { shape: 'view-3' })

async function readReport($: EngineInterface) {
  await update($, view, (v) => ({ ...v, status: undefined }))
  await update($, data, (d): Data => ({ ...d, loading: true }))
  const got = await json<Report>($, ['report', '--json'])
  const patch: Data =
    'json' in got
      ? { report: got.json }
      : 'failed' in got
        ? { noReport: got.failed }
        : { error: got.error }
  await update($, data, (d) => ({ plan: d.plan, planning: d.planning, ...patch }))
}

// plan probes quota and reads the forge, so it runs only when asked.
async function readPlan($: EngineInterface) {
  await update($, view, (v) => ({ ...v, status: undefined }))
  await update($, data, (d): Data => ({ ...d, planning: true }))
  const before = acts
  const got = await json<Plan>($, await onKnownConfig($, ['plan', '--json']), PLAN_TIMEOUT)
  const patch: Data =
    'json' in got ? { plan: got.json } : 'error' in got ? { error: got.error } : {}
  await update($, data, (d) => ({ ...d, planning: undefined, ...patch }))
  // A fresh plan shows what the marks said, unless an act came in while it was planning.
  if ('json' in got)
    await update($, view, (v) => ({ ...v, marks: acts === before ? undefined : v.marks }))
  if ('failed' in got) await update($, view, (v) => ({ ...v, status: `plan: ${got.failed}` }))
}

/** Work nobody awaits: whatever goes wrong ends on the error line, never on a "planning…" for good. */
function settled($: EngineInterface, work: Promise<void>, flag: 'loading' | 'planning') {
  return work.catch((e) => update($, data, (d) => ({ ...d, [flag]: undefined, error: String(e) })))
}

let reportCall: Promise<unknown> | undefined
export let planCall: Promise<unknown> | undefined

export function refresh($: EngineInterface) {
  reportCall ??= settled($, readReport($), 'loading').finally(() => {
    reportCall = undefined
  })
  return reportCall
}

export function loadPlan($: EngineInterface) {
  planCall ??= settled($, readPlan($), 'planning').finally(() => {
    planCall = undefined
  })
  return planCall
}
