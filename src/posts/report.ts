import type { Quota } from '#core/types'
import {
  describeChain,
  needsYou,
  type PlannedUnit,
  type RunPlan,
  type SkipKind,
  type Skipped,
} from '#plan/foreman'
import type { Outcome } from '#worker/deliver/publish'
import type { WorkerStatus } from '#worker/process/worker'
import type { PostState } from './comments'

export interface UnitResult {
  planned: PlannedUnit
  provider?: string
  status: WorkerStatus | 'prepared' | 'skipped' | 'error'
  reason?: string
  turns?: number
  /** The long window before the unit and the worker's last quota reading, to tell what the unit used. */
  baseline?: { name: string; used: number; resetsAt: number }
  quota?: Quota
  /** What the chain published, on its first step. */
  outcome?: Outcome
  /** The one word the unit wrote to `out/verdict`. */
  verdict?: string
  /** Skipped because its `when` or its rule's `quota` didn't hold, or after a step that left nothing: not a failure. */
  passedOver?: true
  /** Failed, and ran again on its provider's next model: the retry is the next result. */
  retried?: true
  /** The step's folder under its chain's `units/<id>/`, e.g. `2-review`, once it started. */
  step?: string
  /** What its provider set aside or changed in the clone for the run, a line each. */
  notes?: string[]
  /** What the step left for the chain, e.g. `2 commits and a report`. */
  made?: string
  /** The step left a report. */
  reported?: true
  /** How the chain's loops went, on its first step, e.g. `2 rounds of review ⇄ fix; until held: verdict approve`. */
  loop?: string
  /** What the step concluded, in a line: its slice's PR body when it leads the slice, else its report. */
  summary?: string
  /** What the step left, relative to the run dir, whichever exist. */
  files?: StepFiles
  /** On the chain's first step: where its rule's `on_done` moved the unit's items that are yours. */
  moved?: Moved[]
  /** On the chain's first step: the items that are yours its result was posted on, by `on_done` or as a task's. */
  result?: Commented[]
  /** On the chain's first step: the questions a step asked instead of going on, and where they went. */
  questions?: Questions
  /** On the chain's first step: why the draft a `continue` left, or a one-off's report, is yours to finish by hand, as `byHand` says; an `ask`'s why is its questions' `unposted`. */
  byHand?: string
  /** On a plan rule's chain's first step: the plan it posted, or why not. */
  plan?: PlanPost
  /** On the chain's first step: what didn't go to the store or come back from it, a line each. */
  store?: string[]
}

/** The item (`source:key`) and URL awaywork posted a comment on, or why it didn't. */
export interface Posted {
  item?: string
  url?: string
  unposted?: string
}

/** A step's `questions.md`, and where it went. */
export interface Questions extends Posted {
  step: string
  text: string
}

/** A plan rule's plan, and where it went: its task ids once it passed its checks, and what the post says of itself. */
export interface PlanPost extends Posted {
  tasks?: string[]
  post?: PostState
}

/** An item (`source:key`) on_done moved, with its updated time after when only the move changed it, or why the move failed. */
export interface Moved {
  item: string
  to: string
  updated?: string
  failed?: string
}

/** An item (`source:key`) the unit's result was posted on, with the comment's URL, the item's updated time after when only the post changed it and what the post says of itself, or why the post failed. */
export interface Commented {
  item: string
  url?: string
  updated?: string
  failed?: string
  post?: PostState
}

export interface StepFiles {
  log?: string
  report?: string
  /** The step's own commits. */
  diff?: string
  /** On the slice's first step: the PR body or push summary (a report chain's joined report) as published. */
  sliceBody?: string
  /** On the slice's first step: the commits it published. */
  sliceDiff?: string
}

/** A skip as report.json holds it: one written before skips had kinds has none. */
export type ReportedSkip = Omit<Skipped, 'kind'> & Partial<Pick<Skipped, 'kind'>>

/** Whether you can act to make the skipped item run; a skip without a kind doesn't say. */
export const needsYouOn = (s: ReportedSkip): s is Skipped => !!s.kind && needsYou[s.kind]

const sinceMs = (s: ReportedSkip) => (s.since ? Date.parse(s.since) : Infinity)

/** Oldest wait first; a skip with no known start follows, in the order it had. */
export const oldestFirst = (a: ReportedSkip, b: ReportedSkip) => sinceMs(a) - sinceMs(b) || 0

/** Skipped items by kind, the largest group first; none when a skip has no kind, as in a report.json from before kinds. */
export function byKind(skipped: ReportedSkip[]): [SkipKind, Skipped[]][] | undefined {
  if (!skipped.every((s): s is Skipped => !!s.kind)) return undefined
  const groups = new Map<SkipKind, Skipped[]>()
  for (const s of skipped) groups.set(s.kind, [...(groups.get(s.kind) ?? []), s])
  return [...groups].sort((a, b) => b[1].length - a[1].length)
}

export interface RunReport {
  runId: string
  dryRun: boolean
  startedAt: Date
  finishedAt: Date
  plan: Omit<RunPlan, 'skipped'> & { skipped: ReportedSkip[] }
  results: UnitResult[]
  /** The last quota a worker saw, per provider. */
  quotas: Record<string, Quota>
  /** Each model's own windows as a worker last saw them, per provider, by model. */
  models?: Record<string, Record<string, Quota['windows']>>
}

const SUMMARY_LENGTH = 200

/** A PR body's or report's first paragraph on one line, past the body's title line, any heading or rule, a gates section where none fired and awaywork's status line. */
export function summaryOf(text: string, titled = false): string | undefined {
  const body = text
    .replace(/<!--[\s\S]*?-->/g, '')
    .trim()
    .split('\n')
    .slice(titled ? 1 : 0)
    .join('\n')
  const paragraph = body
    .split(/\n\s*\n/)
    .map((p) =>
      p
        .split('\n')
        .filter((line) => !/^(#{1,6}(\s|$)|---$)/.test(line.trim()))
        .join(' ')
        .replace(/\s+/g, ' ')
        .trim(),
    )
    .find((p) => p && !p.startsWith('Gates: none fired') && !/^Status: (ask|continue)\b/.test(p))
  if (!paragraph || paragraph.length <= SUMMARY_LENGTH) return paragraph
  return `${paragraph.slice(0, SUMMARY_LENGTH - 1).trimEnd()}…`
}

export interface Chain {
  head: UnitResult
  steps: UnitResult[]
  skills: string
}

/** The run's results grouped by chain, with what the plan chained: e.g. `implement → loop(review ⇄ fix)`. */
export function chains(r: RunReport): Chain[] {
  return r.results
    .filter((u) => !u.planned.chain && !u.retried)
    .map((head) => {
      const { id } = head.planned.unit
      const steps = r.results.filter((u) => u.planned.unit.id === id || u.planned.chain === id)
      const planned = r.plan.units.filter((p) => p.unit.id === id || p.chain === id)
      return { head, steps, skills: describeChain(planned) }
    })
}
