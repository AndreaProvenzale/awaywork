import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { execa } from 'execa'
import { z } from 'zod'
import { killGroupWhenDone } from '../core/group.js'
import type { Job, McpServer, Provider, Quota, WorkerEvent } from '../core/types.js'
import { launch } from '../worker/launch.js'

const PROBE_MODEL = 'claude-haiku-4-5-20251001'
const TOOLS = 'Bash Read Edit Write Grep Glob Skill'
const spans: Record<string, 'short' | 'long'> = { five_hour: 'short', seven_day: 'long' }
const stream = ['--output-format', 'stream-json', '--verbose']
/** Auto-memory lives under ~/.claude whatever the setting sources. */
const noMemory = { autoMemoryEnabled: false }
/** The account's claude.ai connectors load with any login, whatever the setting sources. */
const noConnectors = { ENABLE_CLAUDEAI_MCP_SERVERS: 'false' }
/** The repo's settings, hooks, MCP servers, CLAUDE.md and skills; nothing from ~/.claude. */
const repoOnly = ['--setting-sources', 'project,local']
/** Neither ~/.claude nor the clone's own config: on someone else's PR it is the author's. */
const isolated = ['--setting-sources', '', '--strict-mcp-config']

const configSchema = z.strictObject({
  settings: z
    .string()
    .min(1)
    .optional()
    .describe('Settings file for every worker, relative to the config file; passed as --settings'),
})

/** The stock `claude` binary; the token comes from CLAUDE_CODE_OAUTH_TOKEN or the local login. */
export function claudeProvider(bin = 'claude'): Provider {
  return {
    id: 'claude',
    configSchema,
    credential: 'static',
    quota: 'window',
    unattended: 'allowed',
    package: '@anthropic-ai/claude-code',
    secrets: ['CLAUDE_CODE_OAUTH_TOKEN'],

    async detect() {
      const out = await execa(bin, ['--version']).catch(() => undefined)
      return out ? { installed: true, version: out.stdout.split(' ')[0] } : { installed: false }
    },

    /** One Haiku turn; its rate_limit_event carries both windows. */
    async probe(ctx) {
      const args = ['-p', 'reply ok', '--model', PROBE_MODEL, '--max-turns', '1', ...stream]
      const settings = ['--settings', JSON.stringify(noMemory)]
      const { stdout } = await execa(bin, [...args, ...isolated, ...settings], {
        env: { ...ctx.env, ...noConnectors },
        extendEnv: false,
        reject: false,
      })
      const quotas = stdout.split('\n').flatMap(toEvents)
      return quotas.findLast((e) => e.type === 'quota')?.quota ?? null
    },

    async *run(job, signal) {
      const args = ['-p', job.prompt, '--max-turns', String(job.maxTurns), ...stream]
      if (job.model) args.push('--model', job.model)
      args.push(...(job.unit.foreign ? isolated : repoOnly), '--settings', await settings(job))
      if (job.plugin) args.push('--plugin-dir', job.plugin)
      const servers = Object.entries(job.mcp ?? {})
      if (servers.length > 0) args.push('--mcp-config', mcpConfig(servers))
      const tools = [TOOLS, ...servers.flatMap(([name, s]) => mcpTools(name, s.tools))]
      // Denies whatever isn't allowed, whatever mode the binary would default to.
      args.push('--permission-mode', 'dontAsk', '--allowedTools', tools.join(' '))
      const child = launch(bin, args, {
        cwd: job.dir,
        env: { ...job.env, ...noConnectors },
        extendEnv: false,
        cancelSignal: signal,
        killDescendants: true,
        reject: false,
      })
      killGroupWhenDone(child)
      let done: WorkerEvent | undefined
      for await (const line of child)
        for (const event of toEvents(line)) {
          if (event.type === 'done') done = event
          else yield event
        }
      await child
      yield done && !signal.aborted ? done : { type: 'done', ok: false, turns: 0 }
    },

    instructionsFile: 'CLAUDE.md',
  }
}

export const claude = claudeProvider()

/** The developer's settings file with auto-memory off; it applies whatever the setting sources. */
async function settings(job: Job): Promise<string> {
  const { settings: file } = configSchema.parse(job.config ?? {})
  const theirs = file && JSON.parse(await readFile(resolve(job.configDir ?? '', file), 'utf8'))
  return JSON.stringify({ ...theirs, ...noMemory })
}

/** The servers as `.mcp.json`; the binary expands `${NAME}` from the worker's env. */
function mcpConfig(servers: [string, McpServer][]): string {
  const entries = servers.map(([name, { command, args, env, url, headers }]) => [
    name,
    command ? { command, args, env } : { type: 'http', url, headers },
  ])
  return JSON.stringify({ mcpServers: Object.fromEntries(entries) })
}

function mcpTools(server: string, tools?: string[]): string[] {
  return tools ? tools.map((t) => `mcp__${server}__${t}`) : [`mcp__${server}`]
}

/** Worker events in one stream-json line: tool calls as log lines, quota, and the final result. */
export function toEvents(line: string): WorkerEvent[] {
  const event = parseJson(line)
  if (event?.type === 'rate_limit_event') {
    const unified: Record<string, { utilization: number; resetsAt: number }> =
      event.rate_limit_info?.unifiedWindows ?? {}
    const windows = Object.entries(unified).flatMap(([name, w]) => {
      const span = spans[name]
      return span ? [{ name, span, used: w.utilization, resetsAt: w.resetsAt }] : []
    })
    return windows.length ? [{ type: 'quota', quota: { windows } satisfies Quota }] : []
  }
  if (event?.type === 'assistant')
    return (event.message?.content ?? [])
      .filter((block: { type: string }) => block.type === 'tool_use')
      .map((block: { name: string; input: Record<string, unknown> }) => {
        const mcp = block.name.startsWith('mcp__') ? JSON.stringify(block.input).slice(0, 200) : ''
        const arg = block.input.command ?? block.input.file_path ?? block.input.pattern ?? mcp
        return { type: 'log', line: `${block.name}: ${String(arg)}` }
      })
  if (event?.type === 'result')
    return [
      { type: 'log', line: `result: ${event.subtype}` },
      { type: 'done', ok: event.subtype === 'success', turns: event.num_turns ?? 0 },
    ]
  return []
}

function parseJson(line: string) {
  try {
    return JSON.parse(line)
  } catch {
    return undefined
  }
}
