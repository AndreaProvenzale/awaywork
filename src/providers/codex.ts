import { existsSync } from 'node:fs'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { execa } from 'execa'
import { z } from 'zod'
import { stateDir } from '../config/paths.js'
import { killGroupWhenDone } from '../core/group.js'
import type { Provider, Quota, WorkerEvent } from '../core/types.js'

const AUTH_SECRET = 'CODEX_AUTH_JSON'
/** No user config (MCP servers, notify hooks, plugins), no saved session. */
const EXEC = ['exec', '--json', '--ephemeral', '--ignore-user-config']
/** workspace-write can't commit (.git is read-only). */
const ONLINE = ['--sandbox', 'danger-full-access']
const TOOL_ITEMS = ['command_execution', 'file_change', 'mcp_tool_call', 'web_search']
const DAY_MINS = 24 * 60

const configSchema = z.strictObject({
  config: z
    .record(z.string(), z.union([z.string(), z.number(), z.boolean()]))
    .optional()
    .describe(
      'Config values for every worker, e.g. { model_reasoning_effort: high }; passed as -c',
    ),
})

/**
 * The stock `codex` binary on the local login in `$CODEX_HOME/auth.json`, which Codex rotates in place.
 * CODEX_AUTH_JSON seeds that file only when it is missing; runs and probes hold a per-machine lock.
 */
export function codexProvider(bin = 'codex', lockFile = join(stateDir, 'codex.lock')): Provider {
  async function probe(env: NodeJS.ProcessEnv): Promise<Quota | null> {
    const child = execa(bin, ['app-server'], {
      env,
      extendEnv: false,
      timeout: 60_000,
      reject: false,
    })
    const send = (message: object) => child.stdin.write(`${JSON.stringify(message)}\n`)
    const clientInfo = { name: 'night-shift', title: null, version: '0' }
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
    secrets: [AUTH_SECRET],

    async detect() {
      const out = await execa(bin, ['--version']).catch(() => undefined)
      return out ? { installed: true, version: out.stdout.split(' ').at(-1) } : { installed: false }
    },

    /** `account/rateLimits/read` through the binary's own app server; null when it can't be read. */
    async probe(ctx) {
      const release = await lock(lockFile, ctx.log)
      try {
        await seedAuth(ctx.env)
        return await probe(ctx.env)
      } catch (e) {
        ctx.log(`codex probe: ${(e as Error).message}`)
        return null
      } finally {
        await release()
      }
    },

    async *run(job, signal) {
      if (signal.aborted) return yield { type: 'done', ok: false, turns: 0 }
      const release = await lock(lockFile, () => {})
      const { [AUTH_SECRET]: _, ...env } = job.env
      const capped = new AbortController()
      let turns = 0
      let done: WorkerEvent | undefined
      try {
        await seedAuth(process.env)
        const model = job.model ? ['-m', job.model] : []
        const { config = {} } = configSchema.parse(job.config ?? {})
        const overrides = Object.entries(config).flatMap(([k, v]) => [
          '-c',
          `${k}=${JSON.stringify(v)}`,
        ])
        // After the developer's overrides, so theirs of the same keys lose.
        const sandbox = job.unit.network ? ONLINE : offline(job.dir)
        const args = [...EXEC, ...model, ...overrides, ...sandbox, '-C', job.dir, '-']
        const child = execa(bin, args, {
          cwd: job.dir,
          env,
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

/** A permission profile that reads anywhere, writes the clone (its .git too) and tmp, with no network or web search. */
export function offline(dir: string): string[] {
  const writable = [dir, join(dir, '.git')].map((path) => `${JSON.stringify(path)}="write"`)
  const filesystem = `{":root"="read",":tmpdir"="write",${writable.join(',')}}`
  return [
    ...['-c', 'default_permissions="night"'],
    ...['-c', `permissions.night.filesystem=${filesystem}`],
    ...['-c', 'permissions.night.network.enabled=false'],
    ...['-c', 'web_search="disabled"'],
  ]
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

function codexHome(env: NodeJS.ProcessEnv): string {
  return env.CODEX_HOME ?? join(env.HOME ?? homedir(), '.codex')
}

/** Writes CODEX_AUTH_JSON only when auth.json is missing, so a token Codex refreshed is never overwritten. */
export async function seedAuth(env: NodeJS.ProcessEnv): Promise<void> {
  const file = join(codexHome(env), 'auth.json')
  const seed = env[AUTH_SECRET]
  if (!seed || existsSync(file)) return
  await mkdir(dirname(file), { recursive: true, mode: 0o700 })
  await writeFile(file, seed, { mode: 0o600, flag: 'wx' })
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
