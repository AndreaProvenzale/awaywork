import { dirname, join } from 'node:path'
import type { Command } from 'commander'
import { configPath, loadConfig } from '../config/load.js'
import { runsDir } from '../config/paths.js'
import { isolateFor } from '../core/launch.js'
import { counted } from '../core/report.js'
import { forgeFor } from '../forge/index.js'
import { providersOf } from '../providers/index.js'
import { sourceFor } from '../sources/index.js'
import { replayUnit } from '../worker/replay.js'
import { reportConfigError } from './config.js'
import { abortOnSignals } from './run.js'

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
        await isolateFor(config.isolation, process.env)
        const signal = abortOnSignals()
        const result = await replayUnit({
          config,
          configDir: dirname(path),
          runDir: join(runsDir, run),
          unitId: unit,
          providers: providersOf(config),
          sources: Object.fromEntries(
            Object.entries(config.sources).flatMap(([id, cfg]) => {
              const source = sourceFor(id, cfg)
              return source ? [[id, source]] : []
            }),
          ),
          forge: forgeFor(config),
          ctx: { env: process.env, log: (line) => console.log(`  ${line}`) },
          signal,
        })
        console.log(
          `${unit}: ${result.status}, ${counted(result.commits, 'commit')} on the local branch in ${result.dir}; output in ${result.out}`,
        )
      } catch (e) {
        reportConfigError(e)
      }
    })
}
