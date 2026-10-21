import { constants } from 'node:fs'
import { lstat, mkdir, open, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { execa } from 'execa'
import { z } from 'zod'
import { stateDir } from '../config/paths.js'
import { killGroupWhenDone } from '../core/group.js'
import { launch } from '../core/launch.js'
import { headerSecret } from '../core/mcp.js'
import type { McpServer, Provider, Quota, WorkerEvent } from '../core/types.js'

/** No user config (MCP servers, notify hooks, plugins), no saved session. */
const EXEC = ['exec', '--json', '--ephemeral', '--ignore-user-config']
/** workspace-write can't commit (.git is read-only). */
const FULL_ACCESS = ['--sandbox', 'danger-full-access']
const TOOL_ITEMS = ['command_execution', 'file_change', 'mcp_tool_call', 'web_search']
const DAY_MINS = 24 * 60
const HOSTED_RUNNER =
  'a GitHub-hosted runner has no Codex login, and one copied there goes stale since Codex rotates it in place; run Codex locally or on a self-hosted runner'

const configSchema = z.strictObject({
  config: z
    .record(z.string(), z.union([z.string(), z.number(), z.boolean()]))
    .optional()
    .describe(
      'Config values for every worker, e.g. { model_reasoning_effort: high }; passed as -c',
    ),
})

/** Your Codex login, which `codex login` keeps in `auth.json`. */
export const codexLogin = (env: NodeJS.ProcessEnv) =>
  join(env.CODEX_HOME || join(homedir(), '.codex'), 'auth.json')

/**
 * The stock `codex` binary on the machine's own login (`codex login`), which Codex rotates in place;
 * runs and probes hold a per-machine lock. A worker user gets a copy of it, saved back after its run.
 */
export function codexProvider(
  bin = 'codex',
  lockFile = join(stateDir, 'codex.lock'),
  authFile = codexLogin(process.env),
): Provider {
  // Held from a login lent to the worker until it's saved back, the run in between.
  let lent = false
  async function probe(env: NodeJS.ProcessEnv): Promise<Quota | null> {
    const child = execa(bin, ['app-server'], {
      env,
      extendEnv: false,
      timeout: 60_000,
      reject: false,
    })
    const send = (message: object) => child.stdin.write(`${JSON.stringify(message)}\n`)
    const clientInfo = { name: 'awaywork', title: null, version: '0' }
    send({ id: 1, method: 'initialize', params: { clientInfo, capabilities: null } })
    try {
      for await (const line of child) {
        const message = parseJson(line)
        if (message?.id === 1) {
          send({ method: 'initialized' })
          send({ id: 2, method: 'account/rateLimits/read' })
        }
        if (message?.id !== 2) continue
        // Leaving the loop waits for the app server to exit, which it doesn't on its own.
        child.kill()
        if (message.error) throw new Error(message.error.message)
        return toQuota(message.result?.rateLimits)
      }
      const { shortMessage } = await child
      throw new Error(shortMessage ?? 'the app server sent no rate limits')
    } finally {
      child.kill()
      await child.catch(() => {})
    }
  }

  return {
    id: 'codex',
    configSchema,
    credential: 'rotating',
    quota: 'window',
    unattended: 'grey',
    package: '@openai/codex',
    secrets: [],

    unavailable: (env) => (env.RUNNER_ENVIRONMENT === 'github-hosted' ? HOSTED_RUNNER : undefined),

    async detect() {
      const out = await execa(bin, ['--version']).catch(() => undefined)
      return out ? { installed: true, version: out.stdout.split(' ').at(-1) } : { installed: false }
    },

    /** `account/rateLimits/read` through the binary's own app server; null when it can't be read. */
    async probe(ctx) {
      const release = await lock(lockFile, ctx.log)
      try {
        return await probe(ctx.env)
      } catch (e) {
        ctx.log(`codex probe: ${(e as Error).message}`)
        return null
      } finally {
        await release()
      }
    },

    /**
     * Copies the login into the worker's `home/.codex`, and saves the worker's back once it's yours again:
     * a refresh rotates it, and the copy you kept would die a day later. Not if yours changed meanwhile.
     */
    async login(home) {
      const release = await lock(lockFile, () => {})
      lent = true
      const done = async () => {
        lent = false
        await release()
      }
      try {
        const auth = await readFile(authFile, 'utf8').catch(() => undefined)
        const dir = join(home, '.codex')
        // An earlier phase's, a link included.
        await rm(dir, { recursive: true, force: true })
        await mkdir(dir, { mode: 0o700 })
        if (auth !== undefined) await writeFile(join(dir, 'auth.json'), auth, { mode: 0o600 })
        return async (back) => {
          try {
            const used = back && auth !== undefined ? await loginIn(dir) : undefined
            const mine = await readFile(authFile, 'utf8').catch(() => undefined)
            const same = account(auth) !== undefined && account(used) === account(auth)
            if (used && used !== auth && mine === auth && same) {
              await writeFile(`${authFile}.awaywork`, used, { mode: 0o600 })
              await rename(`${authFile}.awaywork`, authFile)
            }
          } catch {
            // Yours stays as it was.
          } finally {
            await done()
          }
        }
      } catch (e) {
        await done()
        throw e
      }
    },

    async *run(job, signal) {
      if (signal.aborted) return yield { type: 'done', ok: false, turns: 0 }
      const release = lent ? async () => {} : await lock(lockFile, () => {})
      const capped = new AbortController()
      let turns = 0
      let done: WorkerEvent | undefined
      try {
        const model = job.model ? ['-m', job.model] : []
        const { config = {} } = configSchema.parse(job.config ?? {})
        const overrides = Object.entries(config).flatMap(([k, v]) => [
          '-c',
          `${k}=${JSON.stringify(v)}`,
        ])
        const mcp = mcpOverrides(job.mcp ?? {})
        const args = [...EXEC, ...model, ...overrides, ...mcp, ...FULL_ACCESS, '-C', job.dir, '-']
        const child = launch(bin, args, {
          cwd: job.dir,
          env: job.env,
          extendEnv: false,
          input: job.prompt,
          cancelSignal: AbortSignal.any([signal, capped.signal]),
          killDescendants: true,
          reject: false,
        })
        killGroupWhenDone(child)
        for await (const line of child) {
          if (signal.aborted) break
          const event = parseJson(line)
          const tool = event?.type === 'item.completed' && TOOL_ITEMS.includes(event.item?.type)
          if (tool && ++turns > job.maxTurns) {
            yield { type: 'log', line: `result: max_turns (${job.maxTurns})` }
            capped.abort()
            break
          }
          for (const e of toEvents(event)) {
            if (e.type === 'done') done = e
            else yield e
          }
        }
        const { exitCode } = await child
        // The stream carries no quota; reading it mid-run would start a second process on auth.json.
        if (!signal.aborted) {
          const quota = await probe(process.env).catch(() => null)
          if (quota) yield { type: 'quota', quota }
        }
        const ok = done?.type === 'done' && done.ok && exitCode === 0
        yield { type: 'done', ok: ok && !signal.aborted && !capped.signal.aborted, turns }
      } finally {
        await release()
      }
    },

    skillsDir: '.agents/skills',
    instructionsFile: 'AGENTS.md',
  }
}

export const codex = codexProvider()

/** `-c` overrides for the unit's MCP servers; their secrets reach them by name, kept out of the shell's env. */
export function mcpOverrides(servers: Record<string, McpServer>): string[] {
  const set = (key: string, value: unknown) => ['-c', `${key}=${toml(value)}`]
  const secrets = Object.values(servers).flatMap((s) => s.secrets)
  const perServer = Object.entries(servers).flatMap(([name, s]) => {
    const headers = Object.entries(s.headers ?? {}).map(
      ([h, v]) => [h, v, headerSecret(h, v)] as const,
    )
    const plain = headers.flatMap(([h, v, secret]) => (secret ? [] : [[h, v]]))
    const fromEnv = headers.flatMap(([h, , secret]) =>
      secret && !secret.bearer ? [[h, secret.name]] : [],
    )
    const fields = {
      command: s.command,
      args: s.args,
      env: s.env,
      env_vars: s.command && s.secrets.length > 0 ? s.secrets : undefined,
      url: s.url,
      bearer_token_env_var: headers.find(([, , secret]) => secret?.bearer)?.[2]?.name,
      http_headers: plain.length > 0 ? Object.fromEntries(plain) : undefined,
      env_http_headers: fromEnv.length > 0 ? Object.fromEntries(fromEnv) : undefined,
      enabled_tools: s.tools,
      // The default 10 s drops a server silently, e.g. an `npx -y` download on a fresh runner.
      startup_timeout_sec: 60,
    }
    return Object.entries(fields).flatMap(([k, v]) =>
      v === undefined ? [] : set(`mcp_servers.${name}.${k}`, v),
    )
  })
  return [
    ...perServer,
    ...(secrets.length > 0 ? set('shell_environment_policy.exclude', secrets) : []),
  ]
}

/** A string, string array or table of strings as a TOML value. */
function toml(value: unknown): string {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    return JSON.stringify(value)
  const pairs = Object.entries(value).map(([k, v]) => `${JSON.stringify(k)}=${JSON.stringify(v)}`)
  return `{${pairs.join(',')}}`
}

/** Worker events in one `codex exec --json` event: tool calls and errors as log lines, and the turn's end. */
export function toEvents(
  // biome-ignore lint/suspicious/noExplicitAny: an untyped JSON event
  event: any,
): WorkerEvent[] {
  const item = event?.item
  if (event?.type === 'item.completed' && item?.type === 'command_execution')
    return [{ type: 'log', line: `command: ${item.command} (exit ${item.exit_code})` }]
  if (event?.type === 'item.completed' && item?.type === 'file_change')
    return [
      { type: 'log', line: `edit: ${item.changes.map((c: { path: string }) => c.path).join(' ')}` },
    ]
  if (event?.type === 'item.completed' && item?.type === 'mcp_tool_call') {
    const args = JSON.stringify(item.arguments ?? {}).slice(0, 200)
    return [{ type: 'log', line: `mcp_tool_call: ${item.server}/${item.tool}: ${args}` }]
  }
  if (event?.type === 'item.completed' && TOOL_ITEMS.includes(item?.type))
    return [{ type: 'log', line: `${item.type}: ${item.tool ?? item.query ?? ''}` }]
  if (event?.type === 'item.completed' && item?.type === 'error')
    return [{ type: 'log', line: `error: ${item.message}` }]
  if (event?.type === 'error') return [{ type: 'log', line: `error: ${event.message}` }]
  if (event?.type === 'turn.completed')
    return [
      { type: 'log', line: 'result: completed' },
      { type: 'done', ok: true, turns: 0 },
    ]
  if (event?.type === 'turn.failed')
    return [
      { type: 'log', line: `result: failed: ${event.error?.message}` },
      { type: 'done', ok: false, turns: 0 },
    ]
  return []
}

interface RateLimitWindow {
  usedPercent: number
  windowDurationMins: number | null
  resetsAt: number | null
}

/** A window of a day or less is the session window; longer ones (weekly, monthly) are long. */
export function toQuota(
  snapshot: { primary: RateLimitWindow | null; secondary: RateLimitWindow | null } | undefined,
): Quota | null {
  const windows = [snapshot?.primary, snapshot?.secondary].flatMap((w) => {
    if (!w?.windowDurationMins || !w.resetsAt) return []
    const mins = w.windowDurationMins
    const name = mins < DAY_MINS ? `${mins / 60}h` : `${mins / DAY_MINS}d`
    const span = mins <= DAY_MINS ? ('short' as const) : ('long' as const)
    return [{ name, span, used: w.usedPercent / 100, resetsAt: w.resetsAt }]
  })
  return windows.length ? { windows } : null
}

/** The worker's `auth.json` in `dir`, read without following a link it left there. */
async function loginIn(dir: string): Promise<string | undefined> {
  if (!(await lstat(dir)).isDirectory()) return
  const file = await open(join(dir, 'auth.json'), constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const stats = await file.stat()
    return stats.isFile() && stats.size < 65_536 ? await file.readFile('utf8') : undefined
  } finally {
    await file.close()
  }
}

/** The ChatGPT account an `auth.json` logs into, when it has a refresh token. */
function account(auth: string | undefined): string | undefined {
  const tokens = parseJson(auth ?? '')?.tokens
  return typeof tokens?.refresh_token === 'string' && typeof tokens.account_id === 'string'
    ? tokens.account_id
    : undefined
}

/** Waits until no other live process holds the lock file, then takes it. */
export async function lock(
  file: string,
  onWait: (line: string) => void,
): Promise<() => Promise<void>> {
  await mkdir(dirname(file), { recursive: true })
  for (let waited = false; ; waited = true) {
    try {
      await writeFile(file, String(process.pid), { flag: 'wx' })
      return () => rm(file, { force: true })
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e
    }
    const pid = Number(await readFile(file, 'utf8').catch(() => ''))
    if (pid && !alive(pid)) {
      await rm(file, { force: true })
      continue
    }
    if (!waited) onWait(`codex: waiting for pid ${pid}, which holds ${file}`)
    await sleep(1000)
  }
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM'
  }
}

function parseJson(line: string) {
  try {
    return JSON.parse(line)
  } catch {
    return undefined
  }
}
