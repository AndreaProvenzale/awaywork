import { join } from 'node:path'
import { execa } from 'execa'
import { z } from 'zod'
import { killGroupWhenDone } from '../core/group.js'
import type { Provider, Quota } from '../core/types.js'

const TIMEOUT_MS = 60_000
const HOSTED_RUNNER =
  "a GitHub-hosted runner doesn't have your CLI or its login; run it locally or on a self-hosted runner"

export const commandProviderConfig = z
  .strictObject({
    command: z
      .string({ error: 'not a built-in provider; a custom provider needs a `command`' })
      .min(1)
      .describe(
        'Shell command that works the clone; the prompt is in the file named by AWAYWORK_PROMPT. Its output goes to worker.log',
      ),
    probe: z
      .string()
      .min(1)
      .optional()
      .describe(
        "Shell command printing the quota as JSON, { windows: [{ name, span, used, resetsAt }] }, with a long window to pace against; runs in the config file's folder once per plan or run, and in doctor. Unset, the fallback caps apply",
      ),
    secrets: z
      .array(z.string().regex(/^[A-Z_][A-Z0-9_]*$/, 'expected an env var name'))
      .default([])
      .describe('Env vars the command reads; withheld from other workers, listed in Actions'),
    skills_dir: z
      .string()
      .min(1)
      .default('.agents/skills')
      .describe('Where the CLI finds skills in the clone'),
  })
  .describe('A custom provider: any agent CLI, run by a command')

/** `dir` is the config file's folder, set when the config loads. */
export type CommandProviderConfig = z.output<typeof commandProviderConfig> & { dir?: string }

const quotaSchema = z.object({
  windows: z.array(
    z.object({
      name: z.string(),
      span: z.enum(['short', 'long']),
      used: z.number(),
      resetsAt: z.number(),
    }),
  ),
})

export function isCommandProvider(cfg: unknown): cfg is CommandProviderConfig {
  return typeof cfg === 'object' && cfg !== null && 'command' in cfg
}

/** A provider that runs the user's own command: their CLI and login, no live rate-limit events. */
export function commandProvider(
  id: string,
  cfg: CommandProviderConfig,
  probeTimeout = TIMEOUT_MS,
): Provider {
  return {
    id,
    configSchema: commandProviderConfig,
    credential: 'static',
    quota: 'window',
    unattended: 'grey',
    package: '',
    secrets: cfg.secrets,

    unavailable: (env) => (env.RUNNER_ENVIRONMENT === 'github-hosted' ? HOSTED_RUNNER : undefined),

    async detect() {
      const bin =
        cfg.command
          .trim()
          .split(/\s+/)
          .find((word) => !/^[A-Za-z_]\w*=/.test(word)) ?? ''
      const out = await execa(`command -v '${bin.replaceAll("'", "'\\''")}'`, {
        shell: true,
        reject: false,
      })
      return { installed: out.exitCode === 0 }
    },

    async probe(ctx) {
      if (!cfg.probe) return null
      const subprocess = execa(cfg.probe, {
        shell: true,
        cwd: cfg.dir,
        env: ctx.env,
        extendEnv: false,
        timeout: probeTimeout,
        detached: true,
      })
      // A timeout kills only the shell; kill its process group so no child keeps stdout open.
      killGroupWhenDone(subprocess)
      const { stdout } = await subprocess
      let json: unknown
      try {
        json = JSON.parse(stdout)
      } catch {
        throw new Error(`\`${cfg.probe}\` did not print JSON`)
      }
      const parsed = quotaSchema.safeParse(json)
      if (!parsed.success) throw new Error(`probe: ${parsed.error.issues[0]?.message}`)
      const quota: Quota = parsed.data
      return quota.windows.length > 0 ? quota : null
    },

    async *run(job, signal) {
      if (signal.aborted) return yield { type: 'done', ok: false, turns: 0 }
      const child = execa(cfg.command, {
        shell: true,
        cwd: job.dir,
        env: { ...job.env, AWAYWORK_PROMPT: join(job.dir, '.away', 'prompt.md') },
        extendEnv: false,
        all: true,
        cancelSignal: signal,
        killDescendants: true,
        reject: false,
      })
      killGroupWhenDone(child)
      for await (const line of child.iterable({ from: 'all' })) yield { type: 'log', line }
      const { exitCode } = await child
      yield { type: 'done', ok: exitCode === 0 && !signal.aborted, turns: 0 }
    },

    skillsDir: cfg.skills_dir,
    instructionsFile: 'AGENTS.md',
  }
}
