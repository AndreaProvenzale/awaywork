import { dirname, join } from 'node:path'
import type { Command } from 'commander'
import { configPath, loadConfig } from '../config/load.js'
import { runsDir } from '../config/paths.js'
import { githubForge } from '../forge/github.js'
import { providers } from '../providers/index.js'
import { sourceFor } from '../sources/index.js'
import { replayUnit } from '../worker/replay.js'
import { reportConfigError } from './config.js'

export function replayCommand(program: Command): void {
  program
    .command('replay <run> <unit>')
    .description(
      "re-run a past run's unit, its first step, on its base commit and saved context with today's skills and instructions; nothing is pushed",
    )
    .action(async (run: string, unit: string) => {
      try {
        const path = configPath(program.opts().config)
        const config = await loadConfig(path)
        const abort = new AbortController()
        process.once('SIGINT', () => abort.abort())
        const result = await replayUnit({
          config,
          configDir: dirname(path),
          runDir: join(runsDir, run),
          unitId: unit,
          providers,
          sources: Object.fromEntries(
            Object.entries(config.sources).flatMap(([id, cfg]) => {
              const source = sourceFor(id, cfg)
              return source ? [[id, source]] : []
            }),
          ),
          forge: githubForge(),
          ctx: { env: process.env, log: (line) => console.log(`  ${line}`) },
          signal: abort.signal,
        })
        console.log(
          `${unit}: ${result.status}, ${result.commits} commits on the local branch in ${result.dir}; output in ${result.out}`,
        )
      } catch (e) {
        reportConfigError(e)
      }
    })
}
