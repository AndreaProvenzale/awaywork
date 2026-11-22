import { join } from 'node:path'
import { isolated } from '#core/isolation'
import { workerRoot } from '#core/isolation/user'
import type { Deliver, Rule, Unit } from '#core/types'
import { byHand } from '#plan/attempts'
import { describeChain, type PlannedUnit } from '#plan/foreman'
import type { Questions, UnitResult } from '#posts/report'
import type { Previous, Shipped } from '#worker/clone/workspace'
import type { Held, StepReport } from '#worker/deliver/slice'
import type { Ready } from '#worker/units/ready'
import type { Run } from '#worker/units/state'
import type { Snapshot } from './handoff'
import type { OpenLoop } from './loop'
import type { Resolving } from './merge'

/** A failed step to retry: the clone as it found it, and what it leaves the chain if the retry can't start. */
interface Retry {
  result: UnitResult
  start: string
  saved: Snapshot
  keep: () => void
}

/** A chain as it runs: its steps, the clone they share, and what they left so far. */
export interface ChainState {
  readonly chain: PlannedUnit[]
  readonly done: UnitResult[]
  readonly first: PlannedUnit
  readonly base: string
  readonly deliver: Deliver
  readonly opensPr: boolean
  readonly resume: Unit['resume']
  readonly before: number
  readonly pickedUp: string | undefined
  readonly shape: Pick<Unit, 'base' | 'branch' | 'stackedOn' | 'resume'>
  // `changed` diffs from where the chain started, the awaywork PR it took up, else the default branch, as cloned.
  since: string
  readonly dir: string
  readonly chainDir: string
  readonly steps: string | undefined
  readonly loops: Record<number, OpenLoop>
  readonly reports: StepReport[]
  readonly shipped: Shipped[]
  readonly pinned: Record<string, string>
  readonly onDone: Rule['on_done']
  readonly ownGates: Unit['gates']
  cloned?: string
  // What gates compare their scripts with: an awaywork PR's commits are a worker's, so where it left the default branch.
  original?: string
  // Where the chain's commits start in the clone.
  from?: string
  previous?: Previous
  verdict?: string
  // The merge commit awaywork made itself, the one head a merging unit may push.
  merged?: string
  // A merge awaywork left conflicted for the worker, and why it made none of it once the worker ended.
  resolving?: Resolving
  unmerged?: string
  ran: boolean
  interrupted: boolean
  // A step that failed, to run again on its provider's next model.
  retrying?: Retry
  // Why the steps left didn't run, whether they're passed over rather than missed, and whether the rule's `when` did.
  ended?: { reason: string; passedOver?: true; when?: true }
  // A chain that ran and didn't publish, had a step fail or a loop whose `until` never held: on_done doesn't run.
  unfinished: boolean
  // The step that couldn't go on without answers, and its questions.
  asked?: Pick<Questions, 'step' | 'text'>
  leaves?: ReturnType<typeof leave>
  // The note saying the draft it left is yours to finish by hand.
  finishByHand?: string
  // The chain's first step, once it published the chain.
  publishedBy?: UnitResult
  // What didn't go to the store or come back from it.
  readonly storeNotes: string[]
}

/** A chain's state before its first step: its shape, from its first unit, and where its clone goes. */
export async function startChain(
  run: Run,
  chain: PlannedUnit[],
  { shipped = [], pinned = {}, notes = [] }: Partial<Ready> = {},
): Promise<ChainState> {
  const { input, root } = run
  const first = chain[0] as PlannedUnit
  const { repo, base } = first.unit
  const deliver = chain.find((p) => p.unit.deliver !== 'report')?.unit.deliver ?? 'report'
  const opensPr = deliver === 'draft_pr' || deliver === 'pr'
  const { resume, continued: before = 0 } = first.unit
  // The awaywork PR whose branch the chain works on: one a rule took up, or the one a task stacks on.
  const pickedUp =
    first.unit.items
      .flatMap((i) => i.linkedPrs)
      .find((pr) => pr.ours && pr.repo === repo && pr.branch === base)?.url ?? first.unit.stackedOn
  // The chain's base, branch and the PR it stacks on: the awaywork PR the chain started on; a draft it resumes stacks as it did.
  const shape = {
    base,
    branch: first.unit.branch,
    stackedOn: opensPr ? (resume ? first.unit.stackedOn : pickedUp) : undefined,
    resume,
  }
  const dir = isolated() ? await workerRoot(0o700) : join(root, 'work', first.unit.id)
  const { on_done: onDone, gates: declared } = input.plan.queue[first.rule] ?? {}
  // A rule's gate shares no name with a top-level or repo one.
  const ownGates =
    declared &&
    first.unit.gates &&
    Object.fromEntries(Object.entries(first.unit.gates).filter(([name]) => name in declared))
  return {
    chain,
    done: [],
    first,
    base,
    deliver,
    opensPr,
    resume,
    before,
    pickedUp,
    shape,
    since: '',
    dir,
    chainDir: join(input.runDir, 'units', first.unit.id),
    steps: chain.length > 1 ? describeChain(chain) : undefined,
    loops: {},
    reports: [],
    shipped,
    pinned,
    onDone,
    ownGates,
    ran: false,
    interrupted: false,
    unfinished: false,
    storeNotes: [...notes],
  }
}

/** What a step's status file left for a later run, `ask` or `continue`, and why no later run goes on with its draft, if none will. */
export function leave(
  run: Run,
  { first, before, opensPr }: ChainState,
  status: Held['status'],
): Held & { byHand?: string } {
  const continued = status === 'continue' ? before + 1 : before
  const { oneOff } = first.unit
  const refused = oneOff
    ? 'ran with --skill, no later run goes on with it'
    : run.input.forge.ownDraftsRefused
  const stop = (opensPr || (oneOff && status === 'continue')) && byHand({ continued, refused })
  return { status, continued, ...(stop && { byHand: stop.why }) }
}
