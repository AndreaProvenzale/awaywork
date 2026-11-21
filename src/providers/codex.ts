import { constants } from 'node:fs'
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { execa } from 'execa'
import { z } from 'zod'
import { rootStateDir } from '#config/paths'
import { codexSandboxStarts, whereRuns, workerHome } from '#core/isolation'
import { launch } from '#core/launch'
import type { Job, McpServer, Provider, Quota, WorkerEvent } from '#core/types'
import { parseJson } from '#util/json'
import { lock } from '#util/lock'
import { killGroupSoon, killGroupWhenDone } from '#util/process'

/** No user config (MCP servers, notify hooks, plugins), no saved session. */
const EXEC = ['exec', '--json', '--ephemeral', '--ignore-user-config']
/** Where the sandbox can't start: workspace-write can't commit (.git is read-only), so the shell is open. */
const FULL_ACCESS = ['--sandbox', 'danger-full-access']
const PROFILE = 'awaywork'
const HOOKED = ['.claude', '.mcp.json']
/** The proxy's line in a command's output when it reached a host outside the profile's `domains`. */
const BLOCKED = /Network access to \\*"([^"\\]+)\\*" was blocked/g
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
  lockFile = join(rootStateDir, 'codex.lock'),
  authPath?: string,
  startsSandbox = (job: Job, signal: AbortSignal) => codexSandboxStarts(whereRuns(job.dir), signal),
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
    install: { npm: '@openai/codex' },
    secrets: [],
    loginDir: { env: 'CODEX_HOME', default: '~/.codex', command: 'codex login' },

    /** `codex login status`'s line, e.g. `Logged in using ChatGPT`. */
    async account(env) {
      const status = await execa(bin, ['login', 'status'], { env, extendEnv: false, reject: false })
      const line = (status.stderr.trim() || status.stdout.trim()).split('\n').at(-1) ?? ''
      if (status.failed) throw new Error(line || 'not logged in')
      return line
    },

    unavailable: (env) => (env.RUNNER_ENVIRONMENT === 'github-hosted' ? HOSTED_RUNNER : undefined),

    async detect() {
      const out = await execa(bin, ['--version']).catch(() => undefined)
      return out ? { installed: true, version: out.stdout.split(' ').at(-1) } : { installed: false }
    },

    /** `account/rateLimits/read` through the binary's own app server; null when it can't be read. */
    async probe(ctx) {
      const release = await lock(lockFile, (line) => ctx.log(`codex: ${line}`))
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
     * Copies the login into the worker's `home/.codex`, and saves the worker's refresh of it back once it's yours
     * again: a refresh rotates it, and the copy you kept would die a day later. Only its tokens, and not if yours changed meanwhile.
     */
    async login(home, log) {
      // Read now, not at import: a CODEX_HOME may come from awaywork's env file.
      const authFile = authPath ?? codexLogin(process.env)
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
            if (!back || auth === undefined) return
            const used = await loginIn(dir)
            if (used === auth) return
            if ((await readFile(authFile, 'utf8').catch(() => undefined)) !== auth)
              throw new Error('yours changed since it was lent')
            const saved = refreshOf(auth, used)
            if (!saved)
              throw new Error(
                "the worker's isn't a refresh of the one lent: its mode, API key or account differs",
              )
            await writeFile(`${authFile}.awaywork`, saved, { mode: 0o600 })
            await rename(`${authFile}.awaywork`, authFile)
          } catch (e) {
            log?.(`codex: kept your login as it was: ${(e as Error).message}`)
          } finally {
            // rm unlinks a link the worker left there, never what it points to.
            if (back) await rm(dir, { recursive: true, force: true }).catch(() => {})
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
      const logged = new Set<string>()
      let excludes: string | undefined
      try {
        const model = job.model ? ['-m', job.model] : []
        const { config = {} } = configSchema.parse(job.config ?? {})
        const overrides = Object.entries(config).flatMap(([k, v]) => [
          '-c',
          `${k}=${JSON.stringify(v)}`,
        ])
        const mcp = mcpOverrides(job.mcp ?? {})
        const walled = await startsSandbox(job, signal)
        if (!walled && !signal.aborted)
          yield {
            type: 'log',
            line: "Codex's sandbox can't start here: its shell runs unsandboxed",
          }
        const shell = walled ? shellWall(job) : FULL_ACCESS
        if (walled && process.platform === 'linux') excludes = await writeMaskExcludes()
        const args = [
          ...EXEC,
          ...model,
          ...overrides,
          ...mcp,
          ...shell,
          ...ignoreMasks(excludes),
          '-C',
          job.dir,
          '-',
        ]
        const child = launch(bin, args, {
          cwd: job.dir,
          env: job.env,
          tmpdir: walled && workerHome(job.dir) ? '/var/tmp' : undefined,
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
            if (e.type === 'done') {
              done = e
              killGroupSoon(child)
            } else yield e
            if (e.type === 'log') logged.add(e.line)
          }
        }
        const { exitCode, stderr, isTerminated } = await child
        // Codex rejects some blocked commands at spawn, with no item in the stream.
        if (walled && !signal.aborted)
          for (const e of refusals(String(stderr ?? ''))) if (!logged.has(e.line)) yield e
        // The stream carries no quota; reading it mid-run would start a second process on auth.json.
        if (!signal.aborted) {
          const quota = await probe(process.env).catch(() => null)
          if (quota) yield { type: 'quota', quota }
        }
        const ok = done?.type === 'done' && done.ok && (exitCode === 0 || isTerminated)
        yield { type: 'done', ok: ok && !signal.aborted && !capped.signal.aborted, turns }
      } finally {
        if (excludes) await rm(excludes, { recursive: true, force: true })
        await release()
      }
    },

    skillsDir: '.agents/skills',
    instructionsFile: 'AGENTS.md',
  }
}

export const codex = codexProvider()

/** On Linux, Codex masks an absent read-only path with an empty file: this global excludes file, outside the clone, keeps `HOOKED` out of a commit. Returns its folder. */
async function writeMaskExcludes(): Promise<string> {
  const dir = await mkdtemp('/tmp/awaywork-excludes-')
  // The worker user reads it; it can't write it.
  await chmod(dir, 0o755)
  await writeFile(join(dir, 'ignore'), HOOKED.map((p) => `/${p}\n`).join(''), { mode: 0o644 })
  return dir
}

/** Codex's own policy sets the git config in its shell, as its default excludes drop any variable named `*KEY*`. */
const ignoreMasks = (dir: string | undefined) =>
  dir
    ? Object.entries({
        GIT_CONFIG_COUNT: '1',
        GIT_CONFIG_KEY_0: 'core.excludesFile',
        GIT_CONFIG_VALUE_0: join(dir, 'ignore'),
      }).flatMap(([name, value]) => ['-c', `shell_environment_policy.set.${name}=${toml(value)}`])
    : []

/** A profile whose shell writes the clone and the unit's `writable` paths and reaches only the unit's `network` hosts, none by default. */
export function shellWall(job: Job): string[] {
  const { foreign, untrusted, network = [] } = job.unit
  const hosts = foreign || untrusted ? [] : network
  // Under `user` the worker's HOME is a /tmp folder, read-only to the sandbox otherwise.
  const home = workerHome(job.dir)
  const writable = [
    job.dir,
    join(job.dir, '.git'),
    ...(home ? [home] : []),
    ...(job.writable ?? []),
  ]
  // Codex keeps `.codex` and `.agents` read-only itself; a later Claude round would load these two.
  const hooked = HOOKED.map((p) => join(job.dir, p))
  const filesystem = {
    ':root': 'read',
    ':tmpdir': 'write',
    ...Object.fromEntries(writable.map((p) => [p, 'write'])),
    ...Object.fromEntries(hooked.map((p) => [p, 'read'])),
  }
  const set = (key: string, value: unknown) => ['-c', `${key}=${toml(value)}`]
  const net = `permissions.${PROFILE}.network`
  return [
    ...set('default_permissions', PROFILE),
    ...set(`permissions.${PROFILE}.filesystem`, filesystem),
    ...set('features.network_proxy', true),
    ...set(`${net}.enabled`, true),
    ...set(`${net}.domains`, Object.fromEntries(hosts.map((h) => [h, 'allow']))),
    ...set(`${net}.allow_local_binding`, true),
  ]
}

/** The secret a header value names: `${NAME}`, or `Bearer ${NAME}` for Authorization; undefined for any other shape. */
export function headerSecret(
  header: string,
  value: string,
): { name: string; bearer: boolean } | undefined {
  const [, bearer, name] = value.match(/^(Bearer )?\$\{(\w+)\}$/) ?? []
  if (!name || (bearer && header.toLowerCase() !== 'authorization')) return
  return { name, bearer: !!bearer }
}

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
      // Under a permissions profile, a tool that isn't read-only fails "requires approval" otherwise.
      default_tools_approval_mode: 'approve',
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

/** The hosts the proxy refused in `text`, as log lines. */
const refusals = (text: string): Extract<WorkerEvent, { type: 'log' }>[] =>
  [...new Set([...text.matchAll(BLOCKED)].map((m) => m[1]))].map((host) => ({
    type: 'log',
    line: `network: refused ${host} (agent shell)`,
  }))

/** Worker events in one `codex exec --json` event: tool calls and errors as log lines, and the turn's end. */
export function toEvents(
  // biome-ignore lint/suspicious/noExplicitAny: an untyped JSON event
  event: any,
): WorkerEvent[] {
  const item = event?.item
  if (event?.type === 'item.completed' && item?.type === 'command_execution') {
    return [
      { type: 'log', line: `command: ${item.command} (exit ${item.exit_code})` },
      ...refusals(String(item.aggregated_output ?? '')),
    ]
  }
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
    return [{ name, span, used: w.usedPercent / 100, resetsAt: w.resetsAt, minutes: mins }]
  })
  return windows.length ? { windows } : null
}

/** The worker's `auth.json` in `dir`, read without following a link or blocking on a FIFO it left there. */
async function loginIn(dir: string): Promise<string> {
  if (!(await lstat(dir)).isDirectory()) throw new Error(`${dir} isn't a folder`)
  const flags = constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW
  const file = await open(join(dir, 'auth.json'), flags)
  try {
    const stats = await file.stat()
    if (!stats.isFile() || stats.size >= 65_536)
      throw new Error("the worker's auth.json isn't a small regular file")
    return await file.readFile('utf8')
  } finally {
    await file.close()
  }
}

/** `lent` with the tokens and `last_refresh` of `used`, when `used` refreshes it: the same mode, API key and account. */
function refreshOf(lent: string, used: string): string | undefined {
  const [was, now] = [parseJson(lent), parseJson(used)]
  if (account(lent) === undefined || typeof now?.tokens !== 'object' || now.tokens === null) return
  const same = (key: string) => (now[key] ?? null) === (was[key] ?? null)
  if (!same('auth_mode') || !same('OPENAI_API_KEY')) return
  if (now.tokens.account_id !== was.tokens.account_id) return
  const tokens = { ...was.tokens }
  for (const key of ['access_token', 'id_token', 'refresh_token'])
    if (typeof now.tokens[key] === 'string') tokens[key] = now.tokens[key]
  const refreshed = typeof now.last_refresh === 'string' ? now.last_refresh : was.last_refresh
  return JSON.stringify({ ...was, tokens, last_refresh: refreshed })
}

/** The ChatGPT account an `auth.json` logs into, when it has a refresh token. */
function account(auth: string | undefined): string | undefined {
  const tokens = parseJson(auth ?? '')?.tokens
  return typeof tokens?.refresh_token === 'string' && typeof tokens.account_id === 'string'
    ? tokens.account_id
    : undefined
}
