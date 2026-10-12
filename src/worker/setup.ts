import { execa } from 'execa'
import { killGroupWhenDone } from '../core/group.js'

const TIMEOUT_MS = 15 * 60_000
const TAIL_LINES = 5

export interface SetupOptions {
  /** Names in the env whose values are masked in the output. */
  secrets: string[]
  signal?: AbortSignal
  /** Stop setup at this time. */
  until?: Date
}

/**
 * Runs the repo's setup command in the clone; returns why it failed with its output's tail, never throws.
 * It runs in its own process group, killed when the command exits or is stopped, so nothing it started outlives it.
 */
export async function runSetup(
  command: string,
  dir: string,
  env: NodeJS.ProcessEnv,
  log: (line: string) => void,
  opts: SetupOptions,
): Promise<string | undefined> {
  const { output, failed } = await runCommand(command, dir, env, opts)
  if (output) log(`setup: ${output}`)
  if (!failed) return undefined
  const tail = output.split('\n').slice(-TAIL_LINES).join('\n')
  return [`setup failed: ${failed}`, tail].filter(Boolean).join('\n')
}

/** Runs a shell command in the clone like setup; `failed` says why it didn't exit 0, and `stopped` that Ctrl-C or the window's end cut it short, `timedOut` that it hit the time limit. */
export async function runCommand(
  command: string,
  dir: string,
  env: NodeJS.ProcessEnv,
  { secrets, signal, until }: SetupOptions,
): Promise<{ output: string; failed?: string; stopped?: true; timedOut?: true }> {
  const windowEnds = until !== undefined && until.getTime() < Date.now() + TIMEOUT_MS
  const deadline = AbortSignal.timeout(
    Math.max(0, windowEnds ? until.getTime() - Date.now() : TIMEOUT_MS),
  )
  const stop = signal ? AbortSignal.any([signal, deadline]) : deadline
  const subprocess = execa(command, {
    shell: true,
    cwd: dir,
    env,
    extendEnv: false,
    stdin: 'ignore',
    killDescendants: true,
    reject: false,
    all: true,
  })
  const release = killGroupWhenDone(subprocess, stop)
  const result = await subprocess
  release()

  const values = secrets.flatMap((name) => env[name] || [])
  const output = values.reduce((out, value) => out.replaceAll(value, '***'), result.all.trim())
  if (!result.failed) return { output }
  if (!stop.aborted) return { output, failed: result.shortMessage }
  // A hang fails like a non-zero exit for `until`; a `when` treats `timedOut` as unchecked.
  if (!signal?.aborted && !windowEnds)
    return { output, failed: `timed out after ${TIMEOUT_MS / 60_000} min`, timedOut: true }
  return {
    output,
    failed: signal?.aborted ? 'interrupted' : 'the window ended',
    stopped: true,
  }
}
