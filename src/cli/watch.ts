import { appendFileSync, mkdirSync, renameSync, statSync } from 'node:fs'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { setTimeout } from 'node:timers/promises'
import type { Command } from 'commander'
import { ConfigError, configPath, loadConfig } from '../config/load.js'
import {
  attemptsPath,
  runLockPath,
  runsDir,
  skillsDirOf,
  watchLockPath,
  watchLogPath,
  watchStatePath,
} from '../config/paths.js'
import type { Config } from '../config/schema.js'
import { loadAttempts } from '../core/attempts.js'
import type { RunPlan } from '../core/foreman.js'
import { isolateFor } from '../core/launch.js'
import {
  claimUnits,
  dueUnits,
  nextPoll,
  type Poll,
  releaseUnits,
  soonSources,
} from '../core/poll.js'
import { counted, localTime } from '../core/report.js'
import { lockHolder, takeRunLock } from '../core/run-lock.js'
import { firstOpening, windowEnd, windowRun } from '../core/window.js'
import { exec } from '../forge/gh.js'
import { holdAwake } from '../scheduler/wake.js'
import { maskSecrets } from '../worker/setup.js'
import { probeAndPlan, sourceFailure } from './plan.js'
import { executeRun, newRunId, pruneOld, type RunLog } from './run.js'

export function watchCommand(program: Command): void {
  program
    .command('watch')
    .description(
      'keep running and start a run when a window opens; `schedule install` keeps it running',
    )
    .action(() => {
      const stop = new AbortController()
      // `on`, not `once`: execa's signal-exit re-raises a signal it sees no other listener for.
      for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => stop.abort())
      // Inherited by hooks and workers, so `schedule install` there won't stop this daemon.
      process.env.AWAYWORK_WATCH = String(process.pid)
      return watch(configPath(program.opts().config), stop.signal)
    })
}

type Trigger = 'window' | 'soon'

/** What the daemon is doing, rewritten on each change. */
interface WatchState {
  pid: number
  since: string
  config: string
  runs: { trigger: Trigger; runId: string; until?: string }[]
  /** Each `run: soon` source's next poll, and its failed polls in a row. */
  polls: Record<string, { next: string; failures?: number }>
}

const MINUTE = 60_000
const DAY = 24 * 60 * MINUTE

/** Appends a line to a log, first moving it to `<file>.1` once it's past `max` bytes. */
export function appendLog(file: string, line: string, max = 5 * 2 ** 20): void {
  try {
    if (statSync(file).size > max) renameSync(file, `${file}.1`)
  } catch {}
  mkdirSync(dirname(file), { recursive: true })
  appendFileSync(file, `${line}\n`)
}

const event = (line: string) => appendLog(watchLogPath, `${localTime(new Date())} ${line}`)

const reason = (e: unknown) =>
  e instanceof ConfigError ? e.message : String((e as Error)?.stack ?? e)

/**
 * The daemon: each minute on the wall clock, starts the window run due and polls the sources of
 * `run: soon` rules that are due, starting a soon run for the units due, until `stop`.
 */
export async function watch(path: string, stop: AbortSignal): Promise<void> {
  const lock = await takeRunLock(watchLockPath, 'watch')
  if (!('release' in lock)) {
    console.log(`awaywork watch is already running (pid ${lock.pid})`)
    return
  }
  const state: WatchState = {
    pid: process.pid,
    since: new Date().toISOString(),
    config: path,
    runs: [],
    polls: {},
  }
  const polls: Record<string, Poll> = {}
  // Renamed into place, so `schedule status` never reads it half-written.
  const save = async () => {
    state.polls = Object.fromEntries(
      Object.entries(polls).map(([id, p]) => [
        id,
        { next: new Date(p.next).toISOString(), ...(p.failures && { failures: p.failures }) },
      ]),
    )
    await writeFile(`${watchStatePath}.tmp`, JSON.stringify(state))
    await rename(`${watchStatePath}.tmp`, watchStatePath)
  }
  const daemonLog: RunLog = { info: (line) => event(line), error: (line) => event(line) }
  /** Per-unit locks: the run working on each item, by `source:key`. */
  const held = new Map<string, string>()
  /** Each item's updated time when a run last took it. */
  const seen = new Map<string, string>()
  const running = new Map<string, Promise<void>>()
  let releaseLock: (() => Promise<void>) | undefined
  let releaseAwake: (() => void) | undefined
  let lastId = ''
  // One at a time, so runs starting and ending together take and release the run lock once.
  let turn: Promise<unknown> = Promise.resolve()
  const inTurn = <T>(f: () => Promise<T>): Promise<T> => {
    const next = turn.then(f)
    turn = next.catch(() => {})
    return next
  }

  const finish = (runId: string) =>
    inTurn(async () => {
      running.delete(runId)
      releaseUnits(held, runId)
      state.runs = state.runs.filter((r) => r.runId !== runId)
      if (!running.size) {
        releaseAwake?.()
        await releaseLock?.()
      }
      await save()
    })

  /** Starts a run under the run lock, held while any of the daemon's runs is in progress; the lock's holder when that's someone else. */
  const start = (r: Omit<DaemonRun, 'runId' | 'path' | 'stop' | 'claim'>) =>
    inTurn(async (): Promise<string | { pid: number; runId: string }> => {
      if (!running.size) {
        const taken = await takeRunLock(runLockPath, 'watch')
        if (!('release' in taken)) return taken
        releaseLock = taken.release
        releaseAwake = await holdAwake(exec)
      }
      // A run's id is its start to the second, and two triggers can land in the same one.
      let runId = newRunId()
      for (; runId <= lastId; runId = newRunId()) await setTimeout(1000 - (Date.now() % 1000))
      lastId = runId
      state.runs.push({
        trigger: r.trigger,
        runId,
        ...(r.until && { until: r.until.toISOString() }),
      })
      await save()
      const claim = (plan: RunPlan) => claimUnits(plan, runId, held, seen)
      const run = daemonRun({ ...r, path, runId, stop, claim })
      running.set(
        runId,
        run.finally(() => finish(runId)),
      )
      return runId
    })

  let failed: string | undefined
  let lastEnd: Date | undefined
  let pruned = 0
  let waiting = false
  const lockedOut = (what: string, holder: { pid: number; runId: string }, again: string) => {
    if (!waiting)
      event(
        `${what}, but run ${holder.runId} (pid ${holder.pid}) holds the run lock; trying again ${again}`,
      )
    waiting = true
  }

  /** Polls the soon sources that are due and starts a soon run for the units due; reads no quota. */
  const poll = async (config: Config, now: Date) => {
    const every = soonSources(config)
    for (const id of Object.keys(polls)) if (!(id in every)) delete polls[id]
    const due = Object.keys(every).filter((id) => (polls[id]?.next ?? 0) <= now.getTime())
    if (!due.length) return
    const failures: Record<string, Error & { retryAfter?: number }> = {}
    const { plan, warnings, ctx, secrets } = await probeAndPlan(config, skillsDirOf(path), {
      soon: { sources: due },
      probe: false,
      failed: (id, e) => {
        failures[id] = e
      },
    })
    const at = Date.now()
    for (const id of due) {
      const e = failures[id]
      const before = polls[id]?.failures ?? 0
      const interval = every[id] as number
      const next = nextPoll(interval, at, e && { failures: before + 1, retryAfter: e.retryAfter })
      polls[id] = next
      if (e) {
        const why = maskSecrets(sourceFailure(e).split('\n')[0] ?? '', secrets, ctx.env)
        const asked = e.retryAfter ? ', as it asked' : ''
        event(
          `source ${id}: poll failed, next at ${localTime(new Date(next.next))}${asked}: ${why}`,
        )
      } else if (before) event(`source ${id}: polled fine again, every ${describeSpan(interval)}`)
    }
    const units = dueUnits(plan, await loadAttempts(attemptsPath), seen, held)
    if (config.watch.debug) {
      for (const warning of warnings) event(`poll warning: ${warning.split('\n')[0]}`)
      event(`polled ${due.join(', ')}: ${units.length ? `due ${units.join(', ')}` : 'nothing due'}`)
    }
    await save()
    if (!units.length || stop.aborted) return
    const sources = due.filter((id) => !failures[id])
    const present = !windowEnd(config.windows, now)
    const started = await start({ trigger: 'soon', config, present, soon: { sources, units } })
    if (typeof started !== 'string')
      lockedOut(`${units.join(', ')} due`, started, 'at the next poll')
    else waiting = false
  }

  let polling: Promise<void> | undefined
  let pollFailed: string | undefined
  event(`awaywork watch started, pid ${process.pid}, config ${path}`)
  await save()
  try {
    while (!stop.aborted) {
      const now = new Date()
      let config: Config | undefined
      try {
        config = await loadConfig(path)
        failed = undefined
      } catch (e) {
        if (reason(e) !== failed) event(`config not loaded: ${reason(e)}`)
        failed = reason(e)
      }
      if (config && now.getTime() - pruned >= DAY) {
        pruned = now.getTime()
        await pruneOld(config, now, daemonLog).catch((e) => event(`pruning failed: ${reason(e)}`))
      }
      const inWindow = state.runs.some((r) => r.trigger === 'window')
      const until = config && windowRun(config.windows, now, { running: inWindow, lastEnd })
      if (config && until) {
        const started = await start({ trigger: 'window', config, until, present: false })
        if (typeof started !== 'string') lockedOut('a window is open', started, 'each minute')
        else {
          waiting = false
          lastEnd = until
        }
      }
      if (config && !polling)
        polling = poll(config, now)
          .then(
            () => {
              pollFailed = undefined
            },
            (e) => {
              if (reason(e) !== pollFailed) event(`poll failed: ${reason(e)}`)
              pollFailed = reason(e)
            },
          )
          .finally(() => {
            polling = undefined
          })
      await setTimeout(MINUTE - (Date.now() % MINUTE), undefined, { signal: stop }).catch(() => {})
    }
    await polling
    await Promise.all(running.values())
  } finally {
    await rm(watchStatePath, { force: true })
    event('awaywork watch stopped')
    await lock.release()
  }
}

/** E.g. `5m` or `1h`. */
const describeSpan = (ms: number) =>
  ms % (60 * MINUTE) === 0 ? `${ms / (60 * MINUTE)}h` : `${Math.round(ms / MINUTE)}m`

interface DaemonRun {
  trigger: Trigger
  path: string
  config: Config
  runId: string
  until?: Date
  stop: AbortSignal
  present: boolean
  soon?: { sources: string[]; units: string[] }
  claim: (plan: RunPlan) => RunPlan
}

/** One of the daemon's runs, its full output in `run.log` in its run dir; never throws. */
async function daemonRun(r: DaemonRun): Promise<void> {
  const runDir = join(runsDir, r.runId)
  const runLog = join(runDir, 'run.log')
  const log: RunLog = {
    info: (line, isEvent) => {
      appendFileSync(runLog, `${line}\n`)
      if (isEvent || r.config.watch.debug) event(line)
    },
    error: (line) => {
      appendFileSync(runLog, `${line}\n`)
      event(line)
    },
  }
  const until = r.until ? `, until ${localTime(r.until)}` : ''
  const units = r.soon ? ` for ${r.soon.units.join(', ')}` : ''
  event(`${r.trigger} run ${r.runId} started${until}${units}`)
  try {
    await mkdir(runDir, { recursive: true, mode: 0o700 })
    await isolateFor(r.config.isolation, process.env)
    await executeRun({ ...r, now: new Date(), log, signal: () => r.stop })
  } catch (e) {
    event(`run ${r.runId} failed: ${reason(e)}`)
  }
}

/** SIGTERMs the running daemon, whatever started it, and waits up to `waitMs` for it to exit; its pid when it hasn't. */
export async function stopWatch(waitMs = 2 * MINUTE): Promise<number | undefined> {
  const pid = await lockHolder(watchLockPath)
  if (pid === undefined) return undefined
  console.log(`Stopping awaywork watch (pid ${pid})`)
  try {
    process.kill(pid, 'SIGTERM')
  } catch (e) {
    if (['ESRCH', 'EPERM'].includes((e as NodeJS.ErrnoException).code ?? '')) return undefined
    throw e
  }
  for (const end = Date.now() + waitMs; Date.now() < end; await setTimeout(200))
    if ((await lockHolder(watchLockPath)) !== pid) return undefined
  return pid
}

/** `schedule status`'s lines on the daemon, the next window read from `config` when it isn't running. */
export async function watchStatus(config: string, now = new Date()): Promise<string[]> {
  const state: WatchState | undefined = await readFile(watchStatePath, 'utf8')
    .then(JSON.parse)
    .catch(() => undefined)
  const pid = await lockHolder(watchLockPath)
  const up = pid !== undefined && state?.pid === pid
  const lines = [
    up
      ? `Daemon: running, pid ${pid}, since ${localTime(new Date(state.since))}`
      : 'Daemon: not running',
  ]
  for (const run of up ? (state.runs ?? []) : []) {
    const until = run.until ? `, until ${localTime(new Date(run.until))}` : ''
    lines.push(`Run in progress: ${run.trigger} run ${run.runId}${until}`)
  }
  for (const [id, p] of Object.entries(up ? (state.polls ?? {}) : {})) {
    const backoff = p.failures ? `, backing off after ${counted(p.failures, 'failed poll')}` : ''
    lines.push(`Next poll of ${id}: ${localTime(new Date(p.next))}${backoff}`)
  }
  const windows = await loadConfig(up ? state.config : config).then(
    (c) => c.windows,
    () => undefined,
  )
  const next = windows && firstOpening(windows, now.getTime() + 1, now.getTime() + 8 * DAY)
  if (windows)
    lines.push(`Next window: ${next ? localTime(new Date(next)) : 'none, no windows set'}`)
  lines.push(`Daemon log: ${watchLogPath}`)
  return lines
}
