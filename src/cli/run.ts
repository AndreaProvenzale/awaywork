import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { Command } from 'commander'
import { configPath, loadConfig } from '../config/load.js'
import { attemptsPath, runsDir, skillsDirOf } from '../config/paths.js'
import { loadAttempts, recordAttempts, saveAttempts } from '../core/attempts.js'
import { formatReport, localTime, runLine, summarize } from '../core/report.js'
import { unitStats } from '../core/stats.js'
import { describeWindow, windowEnd } from '../core/window.js'
import { githubForge } from '../forge/github.js'
import { providers } from '../providers/index.js'
import { notify } from '../worker/notify.js'
import { maskSecrets } from '../worker/setup.js'
import { namedUnits, runUnits } from '../worker/units.js'
import { reportConfigError } from './config.js'
import { formatPlan, formatReportForTerminal, listedUnits } from './format.js'
import { probeAndPlan } from './plan.js'
import { unitsFile } from './stats.js'

export function runCommand(program: Command): void {
  program
    .command('run')
    .description('plan the units, start a worker per unit and publish draft PRs and reports')
    .option('--dry-run', 'prepare each workspace (clone, context, prompt) but run no worker')
    .option('--unit <id>', 'run only this unit, by id or item key')
    .option('--scheduled', 'run only inside a window and start no unit after it ends')
    .action(async (opts: { dryRun?: boolean; unit?: string; scheduled?: boolean }) => {
      console.log(`awaywork run at ${localTime(new Date())}`)
      try {
        const path = configPath(program.opts().config)
        const config = await loadConfig(path)
        const until = opts.scheduled ? windowEnd(config.windows, new Date()) : undefined
        if (opts.scheduled && !until) {
          console.log(
            `Outside the windows (${config.windows.map(describeWindow).join(', ')}), nothing to do`,
          )
          return
        }
        const { plan, warnings, ctx, sources, secrets } = await probeAndPlan(
          config,
          skillsDirOf(path),
          { retry: !!opts.unit },
        )
        for (const warning of warnings) console.error(`warning: ${warning}`)
        if (opts.unit && namedUnits(plan, opts.unit).size === 0) {
          console.error(`no unit "${opts.unit}" in this run's plan; awaywork plan lists them`)
          process.exitCode = 1
          return
        }
        const runId = new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15)
        const runDir = join(runsDir, runId)
        await mkdir(runDir, { recursive: true })
        await writeFile(join(runDir, 'plan.txt'), `${formatPlan(plan, warnings)}\n`)
        console.log(`Run ${runId}: ${listedUnits(plan).length} units planned, state in ${runDir}`)

        const abort = new AbortController()
        process.once('SIGINT', () => abort.abort())
        const report = await runUnits({
          config,
          configDir: dirname(path),
          plan,
          runId,
          runDir,
          dryRun: !!opts.dryRun,
          only: opts.unit,
          until,
          providers,
          sources,
          forge: githubForge(),
          ctx: { ...ctx, log: (line) => console.log(`  ${line}`) },
          signal: abort.signal,
        })
        const reportPath = join(runDir, 'report.md')
        await writeFile(reportPath, formatReport(report, warnings))
        await writeFile(join(runDir, unitsFile), JSON.stringify(unitStats(report.results)))
        await saveAttempts(attemptsPath, recordAttempts(await loadAttempts(attemptsPath), report))
        console.log(summarize(report, reportPath))
        if (config.notify) {
          const failure = await notify(config.notify.command, { path: reportPath, runId })
          if (failure) console.error(`notify failed: ${maskSecrets(failure, secrets, ctx.env)}`)
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
