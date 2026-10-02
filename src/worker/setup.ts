import { execa } from 'execa'

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

/** Runs a shell command in the clone like setup; `failed` says why it didn't exit 0, and `stopped` that Ctrl-C or `night.end` cut it short. */
export async function runCommand(
  command: string,
  dir: string,
  env: NodeJS.ProcessEnv,
  { secrets, signal, until }: SetupOptions,
): Promise<{ output: string; failed?: string; stopped?: true }> {
  const nightEnds = until !== undefined && until.getTime() < Date.now() + TIMEOUT_MS
  const deadline = AbortSignal.timeout(
    Math.max(0, nightEnds ? until.getTime() - Date.now() : TIMEOUT_MS),
  )
  const stop = signal ? AbortSignal.any([signal, deadline]) : deadline
  const subprocess = execa(command, {
    shell: true,
    cwd: dir,
    env,
    extendEnv: false,
    stdin: 'ignore',
    detached: true,
    reject: false,
    all: true,
  })
  const killGroup = () => {
    try {
      if (subprocess.pid) process.kill(-subprocess.pid, 'SIGKILL')
    } catch {}
  }
  subprocess.nodeChildProcess.once('exit', killGroup)
  stop.addEventListener('abort', killGroup, { once: true })
  if (stop.aborted) killGroup()
  const result = await subprocess
  stop.removeEventListener('abort', killGroup)

  const values = secrets.flatMap((name) => env[name] || [])
  const output = values.reduce((out, value) => out.replaceAll(value, '***'), result.all.trim())
  if (!result.failed) return { output }
  if (!stop.aborted) return { output, failed: result.shortMessage }
  // A command that hangs fails like one that exits non-zero, so a check doesn't retry it every night.
  if (!signal?.aborted && !nightEnds)
    return { output, failed: `timed out after ${TIMEOUT_MS / 60_000} min` }
  return {
    output,
    failed: signal?.aborted ? 'interrupted' : 'the night window ended',
    stopped: true,
  }
}
