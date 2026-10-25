import { appendFileSync, mkdirSync, renameSync, statSync } from 'node:fs'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { setTimeout } from 'node:timers/promises'
import type { Command } from 'commander'
import { ConfigError, configPath, loadConfig } from '../config/load.js'
import {
  runLockPath,
  runsDir,
  watchLockPath,
  watchLogPath,
  watchStatePath,
} from '../config/paths.js'
import type { Config } from '../config/schema.js'
import { isolateFor } from '../core/launch.js'
import { localTime } from '../core/report.js'
import { lockHolder, takeRunLock } from '../core/run-lock.js'
import { firstOpening, windowRun } from '../core/window.js'
import { exec } from '../forge/gh.js'
import { holdAwake } from '../scheduler/wake.js'
import { executeRun, newRunId, pruneOld, type RunLog } from './run.js'

export function watchCommand(program: Command): void {
  program
    .command('watch')
    .description(
      'keep running and start a run when a window opens; `schedule install` keeps it running',
    )
    .action(() => {
      const stop = new AbortController()
      for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => stop.abort())
      return watch(configPath(program.opts().config), stop.signal)
    })
}

/** What the daemon is doing, rewritten on each change. */
interface WatchState {
  pid: number
  since: string
  config: string
  run?: { trigger: 'window'; runId: string; until: string }
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

/** The daemon: each minute on the wall clock, starts the window run due, until `stop`. */
export async function watch(path: string, stop: AbortSignal): Promise<void> {
  const lock = await takeRunLock(watchLockPath, 'watch')
  if (!('release' in lock)) {
    console.log(`awaywork watch is already running (pid ${lock.pid})`)
    return
  }
  const state: WatchState = { pid: process.pid, since: new Date().toISOString(), config: path }
  const save = () => writeFile(watchStatePath, JSON.stringify(state))
  const daemonLog: RunLog = { info: (line) => event(line), error: (line) => event(line) }
  let failed: string | undefined
  let lastEnd: Date | undefined
  let pruned = 0
  let waiting = false
  let running: Promise<void> | undefined
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
      const until = config && windowRun(config.windows, now, { running: !!running, lastEnd })
      if (config && until) {
        const runId = newRunId()
        const runLock = await takeRunLock(runLockPath, runId)
        if (!('release' in runLock)) {
          if (!waiting)
            event(
              `a window is open, but run ${runLock.runId} (pid ${runLock.pid}) holds the run lock; trying again each minute`,
            )
          waiting = true
        } else {
          waiting = false
          lastEnd = until
          state.run = { trigger: 'window', runId, until: until.toISOString() }
          await save()
          const run = { path, config, runId, until, stop }
          running = windowRunIn(run).finally(async () => {
            await runLock.release()
            delete state.run
            await save()
            running = undefined
          })
        }
      }
      await setTimeout(MINUTE - (Date.now() % MINUTE), undefined, { signal: stop }).catch(() => {})
    }
    await running
  } finally {
    await rm(watchStatePath, { force: true })
    event('awaywork watch stopped')
    await lock.release()
  }
}

/** One window run, its full output in `run.log` in its run dir; never throws. */
async function windowRunIn(r: {
  path: string
  config: Config
  runId: string
  until: Date
  stop: AbortSignal
}): Promise<void> {
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
  event(`window run ${r.runId} started, until ${localTime(r.until)}`)
  const release = await holdAwake(exec)
  try {
    await mkdir(runDir, { recursive: true, mode: 0o700 })
    await isolateFor(r.config.isolation, process.env)
    await executeRun({ ...r, now: new Date(), log, signal: () => r.stop })
  } catch (e) {
    event(`run ${r.runId} failed: ${reason(e)}`)
  } finally {
    release()
  }
}

/** `schedule status`'s lines on the daemon, the next window read from `config` when it isn't running. */
export async function watchStatus(config: string, now = new Date()): Promise<string[]> {
  const state: WatchState | undefined = JSON.parse(
    await readFile(watchStatePath, 'utf8').catch(() => 'null'),
  )
  const pid = await lockHolder(watchLockPath)
  const up = pid !== undefined && state?.pid === pid
  const lines = [
    up
      ? `Daemon: running, pid ${pid}, since ${localTime(new Date(state.since))}`
      : 'Daemon: not running',
  ]
  if (up && state.run)
    lines.push(
      `Run in progress: ${state.run.trigger} run ${state.run.runId}, until ${localTime(new Date(state.run.until))}`,
    )
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
