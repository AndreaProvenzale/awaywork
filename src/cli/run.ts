import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { Command } from 'commander'
import { configPath, loadConfig } from '../config/load.js'
import { runsDir } from '../config/paths.js'
import { formatReport, summarize } from '../core/report.js'
import { githubForge } from '../forge/github.js'
import { providers } from '../providers/index.js'
import { sources } from '../sources/index.js'
import { runNight } from '../worker/night.js'
import { reportConfigError } from './config.js'
import { formatPlan } from './format.js'
import { planTonight } from './plan.js'

export function runCommand(program: Command): void {
  program
    .command('run')
    .description('plan tonight, run a worker per unit and publish draft PRs and reports')
    .option('--dry-run', 'prepare each workspace (clone, context, prompt) but run no worker')
    .option('--unit <id>', 'run only this unit')
    .action(async (opts: { dryRun?: boolean; unit?: string }) => {
      try {
        const path = configPath(program.opts().config)
        const config = await loadConfig(path)
        const { plan, warnings, ctx } = await planTonight(config)
        const runId = new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15)
        const runDir = join(runsDir, runId)
        await mkdir(runDir, { recursive: true })
        await writeFile(join(runDir, 'plan.txt'), `${formatPlan(plan, warnings)}\n`)
        console.log(`Run ${runId}: ${plan.units.length} units planned, state in ${runDir}`)

        const abort = new AbortController()
        process.once('SIGINT', () => abort.abort())
        const report = await runNight({
          config,
          configDir: dirname(path),
          plan,
          runId,
          runDir,
          dryRun: !!opts.dryRun,
          only: opts.unit,
          providers,
          sources,
          forge: githubForge(),
          ctx: { ...ctx, log: (line) => console.log(`  ${line}`) },
          signal: abort.signal,
        })
        const reportPath = join(runDir, 'report.md')
        await writeFile(reportPath, formatReport(report))
        console.log(summarize(report, reportPath))
      } catch (e) {
        reportConfigError(e)
      }
    })

  program
    .command('report [id]')
    .description("print a run's morning report; the latest by default")
    .action(async (id?: string) => {
      const runs = (await readdir(runsDir).catch(() => [])).sort()
      const run = id ?? runs.at(-1)
      if (!run) {
        console.error(`no runs in ${runsDir}`)
        process.exitCode = 1
        return
      }
      const text = await readFile(join(runsDir, run, 'report.md'), 'utf8').catch(() => undefined)
      if (text === undefined) {
        console.error(`no report for run ${run} in ${runsDir}`)
        process.exitCode = 1
      } else console.log(text)
    })
}
