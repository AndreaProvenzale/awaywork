import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { Command } from 'commander'
import { configPath, loadConfig } from '../config/load.js'
import { attemptsPath, runsDir } from '../config/paths.js'
import { loadAttempts, recordAttempts, saveAttempts } from '../core/attempts.js'
import { formatReport, runLine, summarize } from '../core/report.js'
import { nightEnd } from '../core/window.js'
import { githubForge } from '../forge/github.js'
import { providers } from '../providers/index.js'
import { sourceFor } from '../sources/index.js'
import { runNight } from '../worker/night.js'
import { notify } from '../worker/notify.js'
import { reportConfigError } from './config.js'
import { formatPlan, formatReportForTerminal, listedUnits } from './format.js'
import { planTonight } from './plan.js'

export function runCommand(program: Command): void {
  program
    .command('run')
    .description('plan tonight, run a worker per unit and publish draft PRs and reports')
    .option('--dry-run', 'prepare each workspace (clone, context, prompt) but run no worker')
    .option('--unit <id>', 'run only this unit, by id or item key')
    .option('--scheduled', 'run only inside the night window and start no unit after it ends')
    .action(async (opts: { dryRun?: boolean; unit?: string; scheduled?: boolean }) => {
      try {
        const path = configPath(program.opts().config)
        const config = await loadConfig(path)
        const until = opts.scheduled ? nightEnd(config.night, new Date()) : undefined
        if (opts.scheduled && !until) {
          console.log(
            `Outside the night window (${config.night.start}-${config.night.end}), nothing to do`,
          )
          return
        }
        const { plan, warnings, ctx } = await planTonight(config, { retry: !!opts.unit })
        const runId = new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15)
        const runDir = join(runsDir, runId)
        await mkdir(runDir, { recursive: true })
        await writeFile(join(runDir, 'plan.txt'), `${formatPlan(plan, warnings)}\n`)
        console.log(`Run ${runId}: ${listedUnits(plan).length} units planned, state in ${runDir}`)

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
          until,
          providers,
          sources: Object.fromEntries(
            Object.entries(config.sources).flatMap(([id, cfg]) => {
              const source = sourceFor(id, cfg)
              return source ? [[id, source]] : []
            }),
          ),
          forge: githubForge(),
          ctx: { ...ctx, log: (line) => console.log(`  ${line}`) },
          signal: abort.signal,
        })
        const reportPath = join(runDir, 'report.md')
        await writeFile(reportPath, formatReport(report))
        await saveAttempts(attemptsPath, recordAttempts(await loadAttempts(attemptsPath), report))
        console.log(summarize(report, reportPath))
        if (config.notify) {
          const failure = await notify(config.notify.command, { path: reportPath, runId })
          if (failure) console.error(`notify failed: ${failure}`)
        }
      } catch (e) {
        reportConfigError(e)
      }
    })

  program
    .command('report [id]')
    .description("print a run's morning report; the latest by default")
    .option('--list', 'list the last 20 runs: units, draft PRs and reports')
    .action(async (id: string | undefined, opts: { list?: boolean }) => {
      const runs = (await readdir(runsDir).catch(() => [])).sort()
      if (opts.list) {
        if (runs.length === 0) console.log(`no runs in ${runsDir}`)
        for (const run of runs.slice(-20).reverse()) {
          const text = await readFile(join(runsDir, run, 'report.md'), 'utf8').catch(
            () => undefined,
          )
          console.log(runLine(run, text))
        }
        return
      }
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
      } else console.log(process.stdout.isTTY ? formatReportForTerminal(text) : text)
    })
}
