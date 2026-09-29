import { type Allowance, pct } from '../core/budget.js'
import type { Job, Provider, Quota } from '../core/types.js'
import { startWatchdog, type Watchdog } from './watchdog.js'

export type WorkerStatus =
  | 'done'
  | 'failed'
  | 'stopped: quota'
  | 'stopped: session'
  | 'stopped: resources'
  | 'stopped: aborted'
  | 'stopped: night ended'

export interface WorkerResult {
  status: WorkerStatus
  turns: number
  quota?: Quota
  reason?: string
}

export interface WorkerOptions {
  log(line: string): void
  signal?: AbortSignal
  /** Stop the worker at this time. */
  until?: Date
  watch?: (dir: string, onLimit: (reason: string) => void) => Watchdog
}

/** Runs one job; stops it at tonight's ceiling, at `session_max`, at `until`, or when the watchdog trips. The provider enforces the turn cap. */
export async function runWorker(
  provider: Provider,
  job: Job,
  allowance: Allowance,
  { log, signal, until, watch = startWatchdog }: WorkerOptions,
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
  const nightEnd =
    until &&
    setTimeout(
      () => stop('stopped: night ended', 'reached night.end'),
      until.getTime() - Date.now(),
    )

  const result: WorkerResult = { status: 'failed', turns: 0 }
  try {
    for await (const event of provider.run(job, abort.signal)) {
      if (event.type === 'log') log(event.line)
      if (event.type === 'quota') {
        result.quota = event.quota
        const limit = overLimit(event.quota, allowance)
        if (limit) stop(limit.status, limit.reason)
      }
      if (event.type === 'done') {
        result.turns = event.turns
        if (event.ok) result.status = 'done'
      }
    }
  } finally {
    signal?.removeEventListener('abort', onAbort)
    clearTimeout(nightEnd)
    await watchdog.stop()
  }
  return stopped ? { ...result, ...stopped } : result
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
  const short = quota.windows.find((w) => w.span === 'short')
  if (short && a.session && short.used >= a.session.stopAt)
    return {
      status: 'stopped: session',
      reason: `${short.name} at ${pct(short.used)}, stop at ${pct(a.session.stopAt)}`,
    }
}
