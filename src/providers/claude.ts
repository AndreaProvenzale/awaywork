import { execa } from 'execa'
import { z } from 'zod'
import type { Provider, Quota, WorkerEvent } from '../core/types.js'

const PROBE_MODEL = 'claude-haiku-4-5-20251001'
const TOOLS = 'Bash Read Edit Write Grep Glob Skill'
const spans: Record<string, 'short' | 'long'> = { five_hour: 'short', seven_day: 'long' }
const stream = ['--output-format', 'stream-json', '--verbose']
/** Auto-memory lives under ~/.claude whatever the setting sources. */
const noMemory = { autoMemoryEnabled: false }
/** Bash in the OS sandbox, which has no network; a missing sandbox fails instead of running unconfined. */
const offline = {
  ...noMemory,
  sandbox: { enabled: true, failIfUnavailable: true, allowUnsandboxedCommands: false },
}
/** The repo's settings, hooks, MCP servers, CLAUDE.md and skills; nothing from ~/.claude. */
const repoOnly = ['--setting-sources', 'project,local']
/** Neither ~/.claude nor the clone's own config: on someone else's PR it is the author's. */
const isolated = ['--setting-sources', '', '--strict-mcp-config']

/** The stock `claude` binary; the token comes from CLAUDE_CODE_OAUTH_TOKEN or the local login. */
export function claudeProvider(bin = 'claude'): Provider {
  return {
    id: 'claude',
    configSchema: z.strictObject({}),
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
        env: ctx.env,
        extendEnv: false,
        reject: false,
      })
      const quotas = stdout.split('\n').flatMap(toEvents)
      return quotas.findLast((e) => e.type === 'quota')?.quota ?? null
    },

    async *run(job, signal) {
      const args = ['-p', job.prompt, '--max-turns', String(job.maxTurns), ...stream]
      if (job.model) args.push('--model', job.model)
      args.push(...(job.unit.foreign ? isolated : repoOnly))
      args.push('--settings', JSON.stringify(job.unit.network ? noMemory : offline))
      const child = execa(bin, [...args, '--allowedTools', TOOLS], {
        cwd: job.dir,
        env: job.env,
        extendEnv: false,
        cancelSignal: signal,
        reject: false,
      })
      let done: WorkerEvent | undefined
      for await (const line of child)
        for (const event of toEvents(line)) {
          if (event.type === 'done') done = event
          else yield event
        }
      await child
      yield done && !signal.aborted ? done : { type: 'done', ok: false, turns: 0 }
    },

    skillsDir: '.claude/skills',
    instructionsFile: 'CLAUDE.md',
  }
}

export const claude = claudeProvider()

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
        const arg = block.input.command ?? block.input.file_path ?? block.input.pattern ?? ''
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
