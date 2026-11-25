import type { Phase } from '#core/isolation/egress'
import { asWorker } from '#core/isolation/index'
import { type Launch, launch } from '#core/launch'
import type { Provider } from '#core/types'
import { killGroupWhenDone } from '#util/process'
import { forgeTokens } from '#worker/clone/env'

const TIMEOUT_MS = 15 * 60_000
const TAIL_LINES = 5

interface SetupOptions {
  /** Names in the env whose values are masked in the output. */
  secrets: string[]
  signal?: AbortSignal
  /** Stop setup at this time. */
  until?: Date
  /** Stop the command after this long; default 15 minutes. */
  timeoutMs?: number
  /** How the command starts: through the launcher, unless it is awaywork's own and not the repo's. */
  start?: Launch
  /** The hosts it reaches under a worker user, where the network wall holds. */
  egress?: Phase
}

/**
 * Runs the repo's setup command in the clone; returns why it failed with its output's tail, and throws only on a clone lost to the worker user.
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
  { secrets, signal, until, timeoutMs = TIMEOUT_MS, start = launch, egress }: SetupOptions,
): Promise<{ output: string; stdout: string; failed?: string; stopped?: true; timedOut?: true }> {
  const windowEnds = until !== undefined && until.getTime() < Date.now() + timeoutMs
  const deadline = AbortSignal.timeout(
    Math.max(0, windowEnds ? until.getTime() - Date.now() : timeoutMs),
  )
  const stop = signal ? AbortSignal.any([signal, deadline]) : deadline
  const run = async () => {
    const subprocess = start(command, [], {
      shell: true,
      cwd: dir,
      env,
      extendEnv: false,
      stdin: 'ignore',
      killDescendants: true,
      reject: false,
      all: true,
      cancelSignal: stop,
    })
    const release = killGroupWhenDone(subprocess, stop)
    const result = await subprocess
    release()
    return result
  }
  // Only repo code runs as the worker, in a clone it owns while it runs.
  const result = await (start === launch ? asWorker(dir, run, undefined, egress) : run())

  const output = maskSecrets(result.all.trim(), secrets, env)
  const stdout = maskSecrets(result.stdout.trim(), secrets, env)
  if (!result.failed) return { output, stdout }
  if (!stop.aborted) return { output, stdout, failed: result.shortMessage }
  // A hang fails like a non-zero exit for `until`; a `when` treats `timedOut` as unchecked.
  if (!signal?.aborted && !windowEnds)
    return { output, stdout, failed: `timed out after ${timeoutMs / 60_000} min`, timedOut: true }
  return {
    output,
    stdout,
    failed: signal?.aborted ? 'interrupted' : 'the window ended',
    stopped: true,
  }
}

/** Shorter values turn up in ordinary text by chance: a scan passes over them. */
const SCANNED_LENGTH = 12

/** twg's own credentials: twg 1.3.8 marks these `secret` for auth or network in its env registry, all but `TWG_OUTBOUND_AUTH`, a mode. */
const twgTokens = [
  'TWG_TOKEN',
  'TWG_BBC_TOKEN',
  'TWG_OAUTH_ACCESS_TOKEN',
  'TWG_GOVERNATOR_SLAUTH_TOKEN',
  'TWG_ADMIN_TOKEN',
  'TWG_STATLAS_TOKEN',
  'TWG_MCP_TOKEN',
  'TWG_AUTH_STORAGE_KEY',
]

export type SecretScan = Awaited<ReturnType<typeof secretScan>>

/**
 * What awaywork looks for in what it writes out: the `secrets` named in `env`, the forge's and twg's tokens, and each
 * provider's login, read when the scan is made, before a worker gets it, and again at each look as a login rotates, earlier values kept.
 */
export async function secretScan(
  secrets: string[],
  providers: Record<string, Provider>,
  env: NodeJS.ProcessEnv,
) {
  const known = new Map<string, string>()
  const read = async () => {
    const named = [...secrets, ...forgeTokens, ...twgTokens].map((name) => [name, env[name]])
    const logins = await Promise.all(
      Object.values(providers).map(async (p) => Object.entries((await p.loginValues?.(env)) ?? {})),
    )
    for (const [name = '', value] of [...named, ...logins.flat()])
      if (value && value.length >= SCANNED_LENGTH && !known.has(value)) known.set(value, name)
    return [...known]
  }
  await read()
  return {
    /** The name of the first value `text` holds verbatim: a write that holds one is refused, not redacted, as the agent had it. */
    leaked: async (text: string) => (await read()).find(([value]) => text.includes(value))?.[1],
    /** `text` with each value masked, as written and as a JSON string escapes it. */
    mask: async (text: string) =>
      (await read()).reduce(
        (out, [value]) =>
          out.replaceAll(JSON.stringify(value).slice(1, -1), '***').replaceAll(value, '***'),
        text,
      ),
  }
}

/** `text` with the values of the `secrets` named in `env` masked. */
export function maskSecrets(text: string, secrets: string[], env: NodeJS.ProcessEnv): string {
  const values = secrets.flatMap((name) => env[name] || [])
  return values.reduce((out, value) => out.replaceAll(value, '***'), text)
}
