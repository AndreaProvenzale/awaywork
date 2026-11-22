import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { agentPhase } from '#core/egress'
import { AGENT_HOME, asWorker, lostToWorker } from '#core/isolation'
import type { Job, Provider, Quota } from '#core/types'
import { type Allowance, pct, scopedOver } from '#quota/budget'
import { refuseSymlinks } from '#worker/clone/files'
import { type Served, type ServeRequest, startServe } from './serve'
import { startWatchdog, type Watchdog } from './watchdog'

export type WorkerStatus =
  | 'done'
  | 'failed'
  | 'stopped: quota'
  | 'stopped: session'
  | 'stopped: resources'
  | 'stopped: aborted'
  | 'stopped: window ended'
  | 'stopped: time'

export interface WorkerResult {
  status: WorkerStatus
  turns: number
  /** The last reading the worker saw. */
  quota?: Quota
  reason?: string
  /** What the provider set aside or changed in the clone for the run, and what came of serve. */
  notes?: string[]
}

export interface WorkerOptions {
  log(line: string): void
  signal?: AbortSignal
  /** Stop the worker at this time. */
  until?: Date
  /** Stop the worker after this many minutes. */
  maxMinutes?: number
  watch?: (dir: string, onLimit: (reason: string) => void) => Watchdog
  /** The app to start for the agent, inside its phase; it stops once the agent's run is over. */
  serve?: ServeRequest
}

/** Runs one job, with its app up if `serve` is set; stops it at this run's ceiling, at its session limit, at `until`, after `maxMinutes`, or when the watchdog trips. The provider enforces the turn cap. */
export async function runWorker(
  provider: Provider,
  job: Job,
  allowance: Allowance,
  { log, signal, until, maxMinutes, watch = startWatchdog, serve }: WorkerOptions,
): Promise<WorkerResult> {
  const abort = new AbortController()
  let stopped: { status: WorkerStatus; reason: string } | undefined
  const stop = (status: WorkerStatus, reason: string) => {
    if (stopped) return
    stopped = { status, reason }
    log(`stop: ${reason}`)
    abort.abort()
  }
  const onAbort = () => stop('stopped: aborted', 'aborted')
  if (signal?.aborted) onAbort()
  signal?.addEventListener('abort', onAbort)
  const watchdog = watch(job.dir, (reason) => stop('stopped: resources', reason))
  const windowEnd =
    until &&
    setTimeout(
      () => stop('stopped: window ended', 'reached the window end'),
      until.getTime() - Date.now(),
    )
  const timeUp =
    maxMinutes &&
    setTimeout(
      () => stop('stopped: time', `reached unit_minutes (${maxMinutes})`),
      maxMinutes * 60_000,
    )

  const result: WorkerResult = { status: 'failed', turns: 0 }
  const { login } = provider
  let served: Served | undefined
  try {
    await provider.prepare?.(job)
    const notes = (await provider.setAside?.(job)) ?? []
    for (const note of notes) log(note)
    if (notes.length) result.notes = notes
    await asWorker(
      job.dir,
      async () => {
        served = serve && (await startServe(serve, job, abort.signal))
        if (served) {
          log(served.note)
          result.notes = [...(result.notes ?? []), served.note]
        }
        if (abort.signal.aborted) return
        for await (const event of provider.run(served?.job ?? job, abort.signal)) {
          if (event.type === 'log') log(event.line)
          if (event.type === 'quota') {
            result.quota = event.quota
            const limit = overLimit(event.quota, allowance)
            if (limit) stop(limit.status, limit.reason)
          }
          if (event.type === 'done') {
            result.turns = event.turns
            if (event.ok) result.status = 'done'
            else result.reason = event.reason
          }
        }
      },
      login && ((home) => login(home, log)),
      agentPhase(provider, job, log),
    )
  } finally {
    signal?.removeEventListener('abort', onAbort)
    clearTimeout(windowEnd)
    clearTimeout(timeUp)
    // The watchdog first: serve's process is still up for its last look at what it started.
    await watchdog.stop()
    await served?.stop()
    await removeAgentHome(job.dir, log)
  }
  return stopped ? { ...result, ...stopped } : result
}

/** Later steps, the judge and gates are not given the MCP secrets Cursor's `mcp.json` holds. */
async function removeAgentHome(dir: string, log: (line: string) => void): Promise<void> {
  if (lostToWorker(dir)) return
  try {
    await refuseSymlinks(dir, [AGENT_HOME])
    await rm(join(dir, AGENT_HOME), { recursive: true, force: true })
  } catch (error) {
    log(`couldn't remove the agent home: ${error instanceof Error ? error.message : error}`)
  }
}

function overLimit(
  quota: Quota,
  a: Allowance,
): { status: WorkerStatus; reason: string } | undefined {
  if (a.kind !== 'quota') return
  const long = quota.windows.find((w) => w.name === a.window)
  if (long && long.used >= a.ceiling)
    return {
      status: 'stopped: quota',
      reason: `${a.window} at ${pct(long.used)}, ceiling ${pct(a.ceiling)}`,
    }
  const scoped = scopedOver(a, quota.windows)
  if (scoped) return { status: 'stopped: quota', reason: scoped }
  const short = quota.windows.find((w) => w.span === 'short')
  if (short && a.session && short.used >= a.session.stopAt)
    return {
      status: 'stopped: session',
      reason: `${short.name} at ${pct(short.used)}, stop at ${pct(a.session.stopAt)}`,
    }
}
