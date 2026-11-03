import { lstat, mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { execa } from 'execa'
import { z } from 'zod'
import { killGroupWhenDone } from '../core/group.js'
import { AGENT_HOME, launch } from '../core/launch.js'
import type { Job, McpServer, Provider, WorkerEvent } from '../core/types.js'

/** Never `--force` or `--approve-mcps`: the allowlist in `cli-config.json` decides, and the clone's `.cursor/mcp.json` stays off. */
const PRINT = ['-p', '--output-format', 'stream-json', '--trust']
const TOOLS = ['Shell(*)', 'Read(**)', 'Write(**)']
/** As the runner's user, not root, outside its home, which the worker user can't enter (docs/providers.md). */
const INSTALL = [
  'sudo install -d -o "$USER" /opt/cursor',
  'curl -fsS https://cursor.com/install | HOME=/opt/cursor bash',
  'sudo ln -sf "$(readlink -f /opt/cursor/.local/bin/agent)" /usr/local/bin/agent',
  'agent --version',
].join('\n')

/** The `HOME` of a run, fresh each time: with yours, Cursor loads your skills, MCP servers, hooks and rules. */
const homeOf = (job: Job) => join(job.dir, AGENT_HOME)

/** Cursor's `agent` binary on `CURSOR_API_KEY`: a fresh `HOME` hides the Keychain login. */
export function cursorProvider(bin = 'agent'): Provider {
  return {
    id: 'cursor',
    bin,
    configSchema: z.strictObject({}),
    credential: 'static',
    quota: 'credits',
    unattended: 'allowed',
    install: { script: INSTALL },
    secrets: ['CURSOR_API_KEY'],

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
      await rm(homeOf(job), { recursive: true, force: true })
      await mkdir(dir, { recursive: true, mode: 0o700 })
      const servers = job.mcp ?? {}
      await writeFile(join(dir, 'cli-config.json'), JSON.stringify(cliConfig(servers)))
      await writeFile(join(dir, 'mcp.json'), JSON.stringify(mcpConfig(servers)))
    },

    async *run(job, signal) {
      if (signal.aborted) return yield { type: 'done', ok: false, turns: 0 }
      const capped = new AbortController()
      const model = job.model ? ['--model', job.model] : []
      const plugin = job.plugin ? ['--plugin-dir', job.plugin] : []
      // Either would point Cursor at your own config.
      const { CURSOR_CONFIG_DIR, XDG_CONFIG_HOME, ...env } = job.env
      const child = launch(bin, [...PRINT, ...model, ...plugin], {
        cwd: job.dir,
        // Without it, Cursor saves its session to the Keychain, and macOS asks.
        env: { ...env, AGENT_CLI_CREDENTIAL_STORE: 'memory' },
        extendEnv: false,
        home: homeOf(job),
        input: job.prompt,
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
        if (event?.type === 'result') result = event.subtype
        yield* toEvents(event)
      }
      const { exitCode, stderr } = await child
      const stopped = signal.aborted || capped.signal.aborted
      if (exitCode !== 0 && !stopped && stderr)
        yield { type: 'log', line: `error: ${String(stderr).trim().split('\n')[0]}` }
      yield { type: 'done', ok: result === 'success' && exitCode === 0 && !stopped, turns }
    },

    instructionsFile: 'AGENTS.md',
    // Cursor also runs Claude Code's project hooks, and takes permissions from its settings.
    repoConfig: [
      '.cursor/hooks.json',
      '.cursor/cli.json',
      '.claude/settings.json',
      '.claude/settings.local.json',
    ],
  }
}

export const cursor = cursorProvider()

/** Cursor's own tools, and each server's tools, or all of them when the server names none. */
export function cliConfig(servers: Record<string, McpServer>) {
  const mcp = Object.entries(servers).flatMap(([name, s]) =>
    (s.tools ?? ['*']).map((tool) => `Mcp(${name}:${tool})`),
  )
  return { version: 1, permissions: { allow: [...TOOLS, ...mcp], deny: [] } }
}

/** The servers as `mcp.json`; Cursor expands `${env:NAME}` from its own env, and a stdio server gets only the env named here. */
export function mcpConfig(servers: Record<string, McpServer>) {
  const fromEnv = (name: string) => `\${env:${name}}`
  const entries = Object.entries(servers).map(([name, s]) => [
    name,
    s.command
      ? {
          command: s.command,
          args: s.args,
          env: { ...s.env, ...Object.fromEntries(s.secrets.map((n) => [n, fromEnv(n)])) },
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
                v.replace(/\$\{(\w+)\}/g, (_, n) => fromEnv(n)),
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

function parseJson(line: string) {
  try {
    return JSON.parse(line)
  } catch {
    return undefined
  }
}
