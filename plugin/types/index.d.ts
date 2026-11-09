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

export type Tab = 'needs' | 'last' | 'next' | 'skipped' | 'config'

export type Action = 'skip' | 'unskip' | 'approve' | 'run'

/** What the pane did to an item, drawn on its cards since the loaded JSON can't show it. */
export type Mark = { skip?: 'skipped' | 'unskipped'; approved?: true; started?: true }

export type View = {
  tab?: Tab
  /** The card selected. */
  row?: string
  /** The detail's first line shown. */
  at?: number
  confirm?: { action: Action; key: string; question: string }
  reading?: { title: string; text: string }
  status?: string
  marks?: Record<string, Mark>
  /** The config tab's selected rule, and what it shows. */
  rule?: number
  source?: 'flow' | 'yaml' | 'diff'
}

/** What `awaywork config explain` prints. */
export type ConfigStep = { skill: string } | { loop: string[]; until: string; max: number }

export type ConfigRule = {
  rule: number
  line?: number
  takes: string
  skill: string
  steps: ConfigStep[]
  leaves: string
  waits: boolean
  plan: boolean
  planned: boolean
  soon: boolean
}

export type ConfigView = {
  valid: true
  windows: string[]
  providers: string[]
  sources: string[]
  reserve?: string
  rules: ConfigRule[]
}

export type Explained = ConfigView | { valid: false; problems: string[] }

/** What the pane reads of `awaywork plan --rules --json`. */
export type RuleTakes = {
  rules: { rule: number; taken: ItemRef[]; takenBy: { rule: number; items: ItemRef[] }[] }[]
  unmatched: (ItemRef & { reason: string })[]
}

export type ConfigState = {
  path?: string
  draft?: string
  /** The config a setup in a control folder is writing, once a tool call named its draft. */
  named?: string
  /** The file shown: the draft while there is one, else the config. */
  file?: string
  /** `config path` says there's none yet: the pane opens on this tab, and it's the only one. */
  setup?: boolean
  text?: string
  previous?: string
  view?: ConfigView
  problems?: string[]
  wantTakes?: boolean
  takes?: RuleTakes
  readingTakes?: boolean
  takesError?: string
}

declare module 'claude-code' {
  interface PluginState {
    awaywork: { data: Shaped<Data>; view: Shaped<View>; config: Shaped<ConfigState> }
  }
}
