import type { Config } from '#config/schema'
import type { Ctx, Forge, Provider, Quota, Source } from '#core/types'
import type { Attempts } from '#plan/attempts'
import type { RunPlan } from '#plan/foreman'
import type { Store } from '#posts/store'
import type { Allowance } from '#quota/budget'
import type { Held, Publisher } from '#worker/deliver/slice'
import type { createChecks } from '#worker/process/checks'
import type { WorkerOptions } from '#worker/process/worker'

export interface RunInput {
  config: Config
  configDir: string
  plan: RunPlan
  runId: string
  runDir: string
  dryRun: boolean
  /** Run only this unit, named by its id or an item key, in any case. */
  only?: string
  /** Start no unit from this time on, and stop the running one at it. */
  until?: Date
  providers: Record<string, Provider>
  sources: Record<string, Source>
  forge: Forge
  ctx: Ctx
  /** Logs a unit's start and end, and what went wrong; `ctx.log` when unset. */
  event?: (line: string) => void
  signal?: AbortSignal
  watch?: WorkerOptions['watch']
  /** Why the machine is too short on memory or disk at a clone's dir to start a unit. */
  shortage?: (dir: string) => Promise<string | undefined>
  skillDirs?: { user: string; builtin: string }
  /** Earlier attempts: a chain's first step on an item gets the item's latest report. */
  attempts?: Attempts
  /** Runs each chain when it's this run's turn: awaywork watch runs one worker at a time across its runs. */
  turn?: <T>(chain: () => Promise<T>) => Promise<T>
  /** A `run: soon` run: no notify for a step that sat out or its `when` passed over, as the next poll tries it again. */
  soon?: boolean
}

/** What a run's chains share: its input, secrets and store, the routing as windows fill, the clones' checks, and what earlier chains left. */
export interface Run extends ReturnType<typeof createChecks> {
  input: RunInput
  event: (line: string) => void
  secrets: string[]
  store: Store | undefined
  root: string
  allowances: Record<string, Allowance>
  routed: Record<string, number>
  quotas: Record<string, Quota>
  publisher: Omit<Publisher, 'judge' | 'pin'>
  // The PR each chain opened first, the chains a step ran in, and those whose draft waits for a later run, by id: a task's chain stacks on its dependency's.
  opened: Record<string, { repo: string; branch: string; url: string; head: string }>
  started: Set<string>
  held: Map<string, Held['status']>
  // The post of a task that waits for you, by card: one waits at a time, so none of its other tasks runs after it.
  waiting: Map<string, string>
}
