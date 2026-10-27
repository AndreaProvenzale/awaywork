import { type Allowance, pct } from '../core/budget.js'
import { asWorker } from '../core/launch.js'
import type { Job, Provider, Quota } from '../core/types.js'
import { startWatchdog, type Watchdog } from './watchdog.js'

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
}

export interface WorkerOptions {
  log(line: string): void
  signal?: AbortSignal
  /** Stop the worker at this time. */
  until?: Date
  /** Stop the worker after this many minutes. */
  maxMinutes?: number
  watch?: (dir: string, onLimit: (reason: string) => void) => Watchdog
}

/** Runs one job; stops it at this run's ceiling, at its session limit, at `until`, after `maxMinutes`, or when the watchdog trips. The provider enforces the turn cap. */
export async function runWorker(
  provider: Provider,
  job: Job,
  allowance: Allowance,
  { log, signal, until, maxMinutes, watch = startWatchdog }: WorkerOptions,
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
  try {
    await asWorker(
      job.dir,
      async () => {
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
      },
      login && ((home) => login(home, log)),
    )
  } finally {
    signal?.removeEventListener('abort', onAbort)
    clearTimeout(windowEnd)
    clearTimeout(timeUp)
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
