import type { ChildProcess } from 'node:child_process'
import { type LaunchOptions, start } from './isolation.js'

/**
 * Starts a process that runs repo code: setup, the agent and the checks, never awaywork's own commands.
 * Isolation `none` starts it as is, as the developer's user; `user` starts it as the worker user,
 * and kills every process that user has once it exits, since the developer's user can't signal them;
 * `container` starts it in a fresh container, removed once its client exits, since killing that stops nothing inside.
 * Once it's both stopped by its `cancelSignal` and exited, its output closes a moment later, whatever still holds it.
 */
export function launch<O extends LaunchOptions>(file: string, args: readonly string[], options: O) {
  const subprocess = start(file, args, options)
  const { pid } = subprocess
  if (pid) {
    running.add(pid)
    subprocess.nodeChildProcess.once('exit', () => running.delete(pid))
  }
  closeOutputOnceStopped(subprocess.nodeChildProcess, options.cancelSignal)
  return subprocess
}

/** The launches still running, by pid. */
const running = new Set<number>()
export const launched = () => [...running]

/** How long a stopped launch's output stays open after it exits: past it, only a process that left its group holds it. */
const STOPPED_OUTPUT_MS = 1000

/** A process that left the group, like `setsid sleep 900 &`, would hold the pipe, and the provider reading it, until it exits. */
function closeOutputOnceStopped(child: ChildProcess, signal?: AbortSignal): void {
  if (!signal) return
  const exited = new Promise((ok) => child.once('exit', ok))
  const stopped = new Promise((ok) =>
    signal.aborted ? ok(undefined) : signal.addEventListener('abort', ok, { once: true }),
  )
  void Promise.all([exited, stopped]).then(() =>
    setTimeout(() => {
      child.stdout?.destroy()
      child.stderr?.destroy()
    }, STOPPED_OUTPUT_MS),
  )
}

export type Launch = typeof launch
