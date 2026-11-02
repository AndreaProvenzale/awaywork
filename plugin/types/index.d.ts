/** What the pane reads of `awaywork report --json` and `awaywork plan --json`. */
export type ItemRef = { source: string; key: string; title: string; url?: string | null }

export type Unit = { id: string; repo: string; skill: string; deliver?: string; items: ItemRef[] }

export type Planned = { unit: Unit; chain?: string; provider?: string }

export type Skip = {
  item: ItemRef
  kind?: string
  reason: string
  url?: string | null
  needsYou?: true
}

export type Plan = { units: Planned[]; skipped: Skip[] }

export type Result = {
  planned: Planned
  status: string
  retried?: true
  reason?: string
  summary?: string
  outcome?: { kind: string; url?: string; reason?: string }
}

export type Report = {
  runId: string
  dryRun: boolean
  finishedAt: string
  plan: Plan
  results: Result[]
}

export type Data = {
  report?: Report
  /** Why there's no report to show: no run yet, or the last one left no report.json. */
  noReport?: string
  plan?: Plan
  /** awaywork missing or too old, in one line with the fix. */
  error?: string
  loading?: true
  planning?: true
}

export type Tab = 'needs' | 'last' | 'next' | 'skipped'

export type Action = 'skip' | 'unskip' | 'approve'

/** What the pane did to an item, drawn on its rows since the loaded JSON can't show it. */
export type Mark = { skip?: 'skipped' | 'unskipped'; approved?: true }

export type View = {
  tab?: Tab
  /** The row the focus ring is on. */
  row?: string
  confirm?: { action: Action; key: string; question: string }
  reading?: { title: string; text: string }
  status?: string
  marks?: Record<string, Mark>
}

declare module 'claude-code' {
  interface PluginState {
    awaywork: { data: Shaped<Data>; view: Shaped<View> }
  }
}
