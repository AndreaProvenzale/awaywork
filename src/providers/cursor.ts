import { lstat, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { execa } from 'execa'
import { z } from 'zod'
import { bin as resolveBin } from '#config/paths'
import { AGENT_HOME, cursorSandboxStarts, whereRuns } from '#core/isolation'
import { launch } from '#core/launch'
import type { Job, McpServer, Provider, WorkerEvent } from '#core/types'
import { parseJson } from '#util/json'
import { killGroupSoon, killGroupWhenDone } from '#util/process'
import { inClone } from '#worker/clone/workspace'

/** Never `--force` or `--approve-mcps`: the allowlist in `cli-config.json` decides, and the clone's `.cursor/mcp.json` stays off. */
const PRINT = ['-p', '--output-format', 'stream-json', '--trust']
const TOOLS = ['Read(**)', 'Write(**)']
/** A command matching an allow rule runs outside the sandbox, so with it on there is none. */
const SHELL = 'Shell(*)'
/** The clone's own one adds hosts to the list and is re-read for each command. */
const CLONE_SANDBOX = '.cursor/sandbox.json'
/** The decision log: outside the agent home, which goes with the worker. */
const NETWORK_LOG = '.away/cursor-network.jsonl'
const clonesAside = new Set<string>()
/** What `prepare` found, for `setAside` and `run` of the same job. */
const sandboxedClones = new Map<string, boolean>()
/** A host as the schema spells it: a log line is the shell's to write. */
const HOST = /^[\w-]+(\.[\w-]+)*$/
/** As the runner's user, not root, outside its home, which the worker user can't enter (docs/providers.md). */
const INSTALL = [
  'sudo install -d -o "$USER" /opt/cursor',
  'curl -fsS https://cursor.com/install | HOME=/opt/cursor bash',
  'sudo ln -sf "$(readlink -f /opt/cursor/.local/bin/agent)" /usr/local/bin/agent',
  'agent --version',
].join('\n')

const OWN_SECRETS = ['CURSOR_API_KEY']

/** The `HOME` of a run, fresh each time: with yours, Cursor loads your skills, MCP servers, hooks and rules. */
const homeOf = (job: Job) => join(job.dir, AGENT_HOME)

/** Cursor's `agent` binary on `CURSOR_API_KEY`: a fresh `HOME` hides the Keychain login. */
export function cursorProvider(
  bin = 'agent',
  startsSandbox = (job: Job, signal?: AbortSignal) =>
    cursorSandboxStarts(bin, whereRuns(job.dir), signal),
): Provider {
  return {
    id: 'cursor',
    bin,
    configSchema: z.strictObject({}),
    credential: 'static',
    quota: 'credits',
    unattended: 'allowed',
    install: { script: INSTALL },
    secrets: OWN_SECRETS,

    async detect() {
      const version = (await execa(bin, ['--version']).catch(() => undefined))?.stdout.trim()
      // `agent` is a generic name: Cursor's versions look like 2026.10.22-27dcf5f.
      return version && /^\d{4}\.\d+\.\d+-/.test(version)
        ? { installed: true, version }
        : { installed: false }
    },

    /** Usage shows in the dashboard only. */
    probe: async () => null,

    async prepare(job) {
      if ((await lstat(join(job.dir, '.away')).catch(() => undefined))?.isSymbolicLink())
        throw new Error('.away in the clone is a symlink')
      const dir = join(homeOf(job), '.cursor')
      // Go's module cache is read-only, which rm can't empty; chmod -R follows a link it's named, rm unlinks it.
      if (!(await lstat(homeOf(job)).catch(() => undefined))?.isSymbolicLink())
        await execa(resolveBin('chmod'), ['-R', 'u+rwX', homeOf(job)], { reject: false })
      await rm(homeOf(job), { recursive: true, force: true })
      await mkdir(dir, { recursive: true, mode: 0o700 })
      const servers = job.mcp ?? {}
      const sandboxed = await startsSandbox(job)
      sandboxedClones.set(job.dir, sandboxed)
      await writeFile(
        join(dir, 'cli-config.json'),
        JSON.stringify(cliConfig(servers, sandboxed ? shellHosts(job) : undefined)),
      )
      await writeFile(join(dir, 'mcp.json'), JSON.stringify(mcpConfig(servers, job.env)), {
        mode: 0o600,
      })
      if (!sandboxed) return
      await rm(join(job.dir, NETWORK_LOG), { force: true })
      await writeFile(
        join(dir, 'sandbox.json'),
        JSON.stringify(sandboxConfig(shellHosts(job), join(job.dir, NETWORK_LOG))),
      )
    },

    async setAside(job) {
      return sandboxedClones.get(job.dir) ? moveOut(job.dir) : []
    },

    async finish(dir) {
      sandboxedClones.delete(dir)
      const lines = await refusals(dir)
      if (clonesAside.delete(dir)) await putBack(dir)
      return lines
    },

    async *run(job, signal) {
      if (signal.aborted) return yield { type: 'done', ok: false, turns: 0 }
      const capped = new AbortController()
      const sandboxed = sandboxedClones.get(job.dir)
      if (!sandboxed && !signal.aborted)
        yield { type: 'log', line: "Cursor's sandbox can't start here: its shell runs unsandboxed" }
      const model = job.model ? ['--model', job.model] : []
      const plugin = job.plugin ? ['--plugin-dir', job.plugin] : []
      // Either would point Cursor at your own config.
      const { CURSOR_CONFIG_DIR, XDG_CONFIG_HOME, ...env } = job.env
      // Their values sit in `mcp.json`, so the shell's env doesn't carry them; Cursor's own stay.
      for (const server of Object.values(job.mcp ?? {}))
        for (const n of server.secrets) if (!OWN_SECRETS.includes(n)) delete env[n]
      const child = launch(bin, [...PRINT, ...model, ...plugin], {
        cwd: job.dir,
        // Without it, Cursor saves its session to the Keychain, and macOS asks.
        env: { ...env, AGENT_CLI_CREDENTIAL_STORE: 'memory' },
        extendEnv: false,
        home: homeOf(job),
        input: sandboxed ? `${job.prompt}\n\n${stayInSandbox(shellHosts(job))}` : job.prompt,
        cancelSignal: AbortSignal.any([signal, capped.signal]),
        killDescendants: true,
        reject: false,
      })
      // Its worker-server outlives it, with CURSOR_API_KEY in its env.
      killGroupWhenDone(child)
      let turns = 0
      let result: string | undefined
      for await (const line of child) {
        if (signal.aborted) break
        const event = parseJson(line)
        const tool = event?.type === 'tool_call' && event.subtype === 'completed'
        if (tool && !event.tool_call?.getMcpToolsToolCall && ++turns > job.maxTurns) {
          yield { type: 'log', line: `result: max_turns (${job.maxTurns})` }
          capped.abort()
          break
        }
        if (event?.type === 'result') {
          result = event.subtype
          killGroupSoon(child)
        }
        yield* toEvents(event)
      }
      const { exitCode, isTerminated, stderr } = await child
      const stopped = signal.aborted || capped.signal.aborted
      const exited = exitCode === 0 || (result !== undefined && isTerminated)
      if (!exited && !stopped && stderr)
        yield { type: 'log', line: `error: ${String(stderr).trim().split('\n')[0]}` }
      yield { type: 'done', ok: result === 'success' && exited && !stopped, turns }
    },

    instructionsFile: 'AGENTS.md',
    // Cursor also runs Claude Code's project hooks, and takes permissions from its settings.
    repoConfig: [
      CLONE_SANDBOX,
      '.cursor/hooks.json',
      '.cursor/cli.json',
      '.claude/settings.json',
      '.claude/settings.local.json',
    ],
  }
}

export const cursor = cursorProvider()

/** The hosts a unit's shell reaches: the `network` list, none on an untrusted author's PR. */
const shellHosts = ({ unit }: Job) => (unit.untrusted ? [] : (unit.network ?? []))

/** Cursor's own tools, and each server's tools, or all of them when the server names none; the shell too, open, unless `network` says to wall it. */
export function cliConfig(servers: Record<string, McpServer>, network?: string[]) {
  const mcp = Object.entries(servers).flatMap(([name, s]) =>
    (s.tools ?? ['*']).map((tool) => `Mcp(${name}:${tool})`),
  )
  const allow = [...TOOLS, ...mcp]
  if (!network) return { version: 1, permissions: { allow: [SHELL, ...allow], deny: [] } }
  const networkAccess = network.includes('*') ? 'allow_all' : 'user_config_only'
  return {
    version: 1,
    sandbox: { mode: 'enabled', networkAccess },
    // The edit tool runs outside the sandbox: `.cursor/sandbox.json` could widen the list, and `.claude/settings.json` holds hooks and permissions the next round loads unsandboxed.
    permissions: { allow, deny: ['Write(**/.cursor/**)', 'Write(**/.claude/**)'] },
  }
}

/** On macOS the sandbox refuses even loopback unless listed; test suites bind there. */
const LOOPBACK = ['localhost', '127.0.0.1']

/** The shell reaching only loopback and `hosts`, every refusal in `log`. */
export const sandboxConfig = (hosts: string[], log: string) => ({
  networkPolicy: {
    default: 'deny',
    allow: [...LOOPBACK, ...hosts],
    logging: { decisionLogPath: log, logFormat: 'jsonl' },
  },
})

const stayInSandbox = (hosts: string[]) =>
  `Your shell is sandboxed: it writes only here and reaches ${hosts.length ? hosts.join(', ') : 'no host'}. Asking to run outside the sandbox or for the network is always refused.`

/** The refused hosts in a decision log, one `worker.log` line each; its first line is metadata. */
export function refusedLines(jsonl: string): string[] {
  const hosts = jsonl.split('\n').flatMap((line) => {
    const row = parseJson(line)
    return row?.decision === 'deny' && typeof row.host === 'string' && HOST.test(row.host)
      ? [row.host]
      : []
  })
  return [...new Set(hosts)].map((host) => `network: refused ${host} (agent shell)`)
}

async function refusals(dir: string): Promise<string[]> {
  const file = join(dir, NETWORK_LOG)
  if (!(await lstat(file).catch(() => undefined))?.isFile()) return []
  const lines = refusedLines(await readFile(file, 'utf8'))
  await rm(file)
  return lines
}

const inGit = (dir: string, ...args: string[]) =>
  execa(resolveBin('git'), [...inClone(dir), ...args])

/** Moves the clone's committed `.cursor/sandbox.json` out for the run, kept out of its commits, and says so. */
async function moveOut(dir: string): Promise<string[]> {
  const file = join(dir, CLONE_SANDBOX)
  const text = await readFile(file, 'utf8').catch(() => undefined)
  if (text === undefined) return []
  if ((await realpath(file)) !== join(await realpath(dir), CLONE_SANDBOX))
    throw new Error(`${CLONE_SANDBOX} in the clone links outside it`)
  await inGit(dir, 'update-index', '--skip-worktree', '--', CLONE_SANDBOX)
  await rm(file)
  clonesAside.add(dir)
  const hosts: unknown = parseJson(text)?.networkPolicy?.allow
  const adds = Array.isArray(hosts) && hosts.length ? ` (adds ${hosts.join(', ')})` : ''
  return [`network: set aside ${CLONE_SANDBOX}${adds}`]
}

async function putBack(dir: string): Promise<void> {
  const indexed = await inGit(dir, 'ls-files', '--', CLONE_SANDBOX)
  if (!indexed.stdout) return
  await inGit(dir, 'update-index', '--no-skip-worktree', '--', CLONE_SANDBOX)
  await inGit(dir, 'checkout', '--', CLONE_SANDBOX)
}

/** The servers as `mcp.json`, secrets as literals from `env`: a `${env:NAME}` would keep them in Cursor's env, and so its shell's. */
export function mcpConfig(servers: Record<string, McpServer>, env: NodeJS.ProcessEnv) {
  const literal = (name: string) => env[name] ?? ''
  const entries = Object.entries(servers).map(([name, s]) => [
    name,
    s.command
      ? {
          command: s.command,
          args: s.args,
          env: { ...s.env, ...Object.fromEntries(s.secrets.map((n) => [n, literal(n)])) },
          // A server still starting drops out, e.g. an `npx -y` download on a fresh machine.
          startupTimeoutSec: 60,
        }
      : {
          url: s.url,
          headers:
            s.headers &&
            Object.fromEntries(
              Object.entries(s.headers).map(([h, v]) => [
                h,
                v.replace(/\$\{(\w+)\}/g, (_, n) => literal(n)),
              ]),
            ),
        },
  ])
  return { mcpServers: Object.fromEntries(entries) }
}

/** Worker events in one stream-json event: a log line per tool call once it completes, and the result. */
export function toEvents(
  // biome-ignore lint/suspicious/noExplicitAny: an untyped JSON event
  event: any,
): WorkerEvent[] {
  if (event?.type === 'result') return [{ type: 'log', line: `result: ${event.subtype}` }]
  if (event?.type !== 'tool_call' || event.subtype !== 'completed') return []
  const [kind, call] =
    Object.entries(event.tool_call ?? {}).find(([key]) => key.endsWith('ToolCall')) ?? []
  // biome-ignore lint/suspicious/noExplicitAny: an untyped JSON event
  const { args = {}, result = {} } = (call ?? {}) as any
  const [status, outcome] = Object.entries(result)[0] ?? []
  const refused = status && status !== 'success' ? ` (${status})` : ''
  const line = {
    shellToolCall: () =>
      `command: ${args.command} (${refused ? status : `exit ${(outcome as { exitCode?: number })?.exitCode}`})`,
    editToolCall: () => `edit: ${args.path}${refused}`,
    readToolCall: () => `read: ${args.path}${refused}`,
    grepToolCall: () => `grep: ${args.pattern}${refused}`,
    globToolCall: () => `glob: ${args.globPattern ?? args.pattern}${refused}`,
    mcpToolCall: () =>
      `mcp_tool_call: ${args.providerIdentifier}/${args.toolName}: ${JSON.stringify(args.args ?? {}).slice(0, 200)}${refused}`,
    // A subagent's own tool calls never reach the stream.
    taskToolCall: () => `task: ${args.description}${refused}`,
    getMcpToolsToolCall: () => undefined,
  }[kind ?? '']
  const text = line ? line() : kind && `${kind}: ${JSON.stringify(args).slice(0, 200)}${refused}`
  return text ? [{ type: 'log', line: text }] : []
}
