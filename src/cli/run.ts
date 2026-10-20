import { existsSync } from 'node:fs'
import { appendFile, mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { type Command, Option } from 'commander'
import { configPath, loadConfig } from '../config/load.js'
import {
  approvalsPath,
  attemptsPath,
  remoteDir,
  runLockPath,
  runsDir,
  skillsDirOf,
} from '../config/paths.js'
import { clearApprovals, loadApprovals, saveApprovals } from '../core/approvals.js'
import { loadAttempts, recordAttempts, saveAttempts } from '../core/attempts.js'
import { hostedWorker, isolate } from '../core/launch.js'
import { formatReport, localTime, runLine, summarize } from '../core/report.js'
import { takeRunLock } from '../core/run-lock.js'
import { unitStats } from '../core/stats.js'
import { describeWindow, hostedEnd, runEnd } from '../core/window.js'
import { fetchRun, type UploadedRun, uploadedRuns } from '../forge/artifacts.js'
import { type Exec, exec } from '../forge/gh.js'
import { forgeFor } from '../forge/index.js'
import { providersOf } from '../providers/index.js'
import { WORKFLOW } from '../scheduler/github-actions.js'
import { notifyRun } from '../worker/notify.js'
import { maskSecrets } from '../worker/setup.js'
import { namedUnits, runUnits } from '../worker/units.js'
import { reportConfigError } from './config.js'
import { formatPlan, formatReportForTerminal, listedUnits, reportJson } from './format.js'
import { probeAndPlan, ruleNumber } from './plan.js'
import { gitRoot } from './schedule.js'
import { unitsFile } from './stats.js'

type RunOptions = {
  dryRun?: boolean
  unit?: string
  repo?: string
  rule?: number
  scheduled?: boolean
}

export function runCommand(program: Command): void {
  program
    .command('run')
    .description('plan the units, start a worker per unit and publish draft PRs and reports')
    .option('--dry-run', 'prepare each workspace (clone, context, prompt) but run no worker')
    .option('--unit <id>', 'run only this unit, by id or item key')
    .option('--repo <glob>', 'run only units in repos matching owner/name, * globs')
    .option('--rule <n>', 'run only units of this queue rule, counted from 1', ruleNumber)
    .option('--scheduled', 'run only inside a window and start no unit after it ends')
    .action(async (opts: RunOptions) => {
      console.log(`awaywork run at ${localTime(new Date())}`)
      let release: (() => Promise<void>) | undefined
      try {
        const path = configPath(program.opts().config)
        const config = await loadConfig(path)
        isolate(await hostedWorker(process.env))
        const now = new Date()
        const until = opts.scheduled
          ? runEnd(config.windows, now, process.env)
          : hostedEnd(now, process.env)
        if (opts.scheduled && !until) {
          console.log(
            `Outside the windows (${config.windows.map(describeWindow).join(', ')}), nothing to do`,
          )
          return
        }
        const runId = new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15)
        if (!opts.dryRun) {
          const lock = await takeRunLock(runLockPath, runId)
          if (!('release' in lock)) {
            console.error(
              `already running (pid ${lock.pid}, run ${lock.runId}); if that is stale, delete ${runLockPath}`,
            )
            process.exitCode = 1
            return
          }
          release = lock.release
        }
        const { plan, warnings, ctx, sources, secrets } = await probeAndPlan(
          config,
          skillsDirOf(path),
          { retry: !!opts.unit, repo: opts.repo, rule: opts.rule },
        )
        for (const warning of warnings) console.error(`warning: ${warning}`)
        if (opts.unit && namedUnits(plan, opts.unit).size === 0) {
          console.error(`no unit "${opts.unit}" in this run's plan; awaywork plan lists them`)
          process.exitCode = 1
          return
        }
        if (!plan.units.length && (opts.repo !== undefined || opts.rule !== undefined)) {
          console.error('no unit matches --repo/--rule; awaywork plan lists them')
          process.exitCode = 1
          return
        }
        const runDir = join(runsDir, runId)
        await mkdir(runDir, { recursive: true })
        if (process.env.GITHUB_OUTPUT)
          await appendFile(process.env.GITHUB_OUTPUT, `run-id=${runId}\nrun-dir=${runDir}\n`)
        await writeFile(join(runDir, 'plan.txt'), `${formatPlan(plan, warnings)}\n`)
        console.log(`Run ${runId}: ${listedUnits(plan).length} units planned, state in ${runDir}`)

        const abort = new AbortController()
        for (const signal of ['SIGINT', 'SIGTERM'] as const) {
          process.once(signal, () => abort.abort())
        }
        const report = await runUnits({
          config,
          configDir: dirname(path),
          plan,
          runId,
          runDir,
          dryRun: !!opts.dryRun,
          only: opts.unit,
          until,
          providers: providersOf(config),
          sources,
          forge: forgeFor(config),
          ctx: { ...ctx, log: (line) => console.log(`  ${line}`) },
          signal: abort.signal,
          attempts: await loadAttempts(attemptsPath),
        })
        const reportPath = join(runDir, 'report.md')
        await writeFile(reportPath, formatReport(report, warnings))
        await writeFile(join(runDir, reportJsonFile), reportJson(report, warnings))
        await writeFile(join(runDir, unitsFile), JSON.stringify(unitStats(report.results)))
        await saveAttempts(attemptsPath, recordAttempts(await loadAttempts(attemptsPath), report))
        await saveApprovals(
          approvalsPath,
          clearApprovals(await loadApprovals(approvalsPath), report),
        )
        console.log(summarize(report, reportPath))
        if (config.notify) {
          const failure = await notifyRun(config.notify.command, { path: reportPath, runId })
          if (failure) console.error(`notify failed: ${maskSecrets(failure, secrets, ctx.env)}`)
        }
      } catch (e) {
        reportConfigError(e)
      } finally {
        await release?.()
      }
    })

  program
    .command('report [id]')
    .description("print a run's morning report; the latest by default")
    .option('--list', 'list the last 20 runs: units, draft PRs and reports')
    .addOption(
      new Option('--json', "print the run's results as JSON instead of the markdown").conflicts(
        'list',
      ),
    )
    .action((id: string | undefined, opts: { list?: boolean; json?: boolean }) =>
      printReport(id, !!opts.list, exec, !!opts.json),
    )
}

const reportJsonFile = 'report.json'

interface Run {
  id: string
  dir: string
  uploaded?: UploadedRun
}

/** Prints a run's report, or lists the last 20; inside a control repo, with the runs its workflows uploaded. */
export async function printReport(
  id: string | undefined,
  list: boolean,
  run: Exec = exec,
  json = false,
) {
  const local = (await readdir(runsDir).catch(() => [])).sort()
  const uploaded = id && local.includes(id) ? [] : await remoteRuns(run)
  const runs: Run[] = [
    ...local.map((id) => ({ id, dir: join(runsDir, id) })),
    ...uploaded
      .filter((r) => !local.includes(r.id))
      .map((r) => ({ id: r.id, dir: join(remoteDir, r.repo, r.artifact), uploaded: r })),
  ].sort((a, b) => a.id.localeCompare(b.id))
  const read = (r: Run) =>
    readFile(join(r.dir, json ? reportJsonFile : 'report.md'), 'utf8').catch(() => undefined)

  if (list) {
    if (runs.length === 0) console.log(`no runs in ${runsDir}`)
    const last = runs.slice(-20).reverse()
    const fetched = last.map((r) => r.uploaded && fetchRun(r.uploaded, r.dir, run))
    const failed = (await Promise.allSettled(fetched)).find((f) => f.status === 'rejected')
    if (failed) warnRemote(failed.reason)
    for (const r of last) {
      const tag = r.uploaded ? `  (github: ${r.uploaded.workflow})` : ''
      console.log(runLine(r.id, await read(r)) + tag)
    }
    return
  }
  let picked = id ? runs.find((r) => r.id === id) : runs.at(-1)
  if (picked?.uploaded)
    try {
      await fetchRun(picked.uploaded, picked.dir, run)
    } catch (e) {
      warnRemote(e)
      picked = id ? undefined : runs.findLast((r) => !r.uploaded)
    }
  const which = id ?? picked?.id
  if (!which) {
    console.error(`no runs in ${runsDir}`)
    process.exitCode = 1
    return
  }
  const text = picked && (await read(picked))
  if (text === undefined) {
    console.error(
      `no ${json ? 'JSON report' : 'report'} for run ${which} in ${picked ? dirname(picked.dir) : runsDir}`,
    )
    process.exitCode = 1
    if (json) return
    const steps = picked ? await startedSteps(picked.dir) : []
    const running = steps.pop()
    if (running) {
      console.log(`Done so far: ${steps.map((s) => s.name).join(', ') || 'nothing'}`)
      console.log(`Running (or cut short): ${running.name}`)
      console.log(`Its stream: ${running.log}`)
    }
  } else console.log(json || !process.stdout.isTTY ? text : formatReportForTerminal(text))
}

/** The steps a run started, oldest first: each has a `worker.log`, and the last one written is the latest. */
async function startedSteps(runDir: string): Promise<{ name: string; log: string }[]> {
  const unitsDir = join(runDir, 'units')
  const steps: { name: string; log: string; at: number }[] = []
  for (const unit of await readdir(unitsDir).catch(() => []))
    for (const step of await readdir(join(unitsDir, unit)).catch(() => [])) {
      const log = join(unitsDir, unit, step, 'worker.log')
      const info = await stat(log).catch(() => undefined)
      if (info) steps.push({ name: `${unit}/${step}`, log, at: info.mtimeMs })
    }
  return steps.sort((a, b) => a.at - b.at)
}

/** The runs the control repo in this directory uploaded: none outside one, and none with a warning when GitHub fails. */
async function remoteRuns(run: Exec): Promise<UploadedRun[]> {
  // A runner's own report is of the run it just made, never of an earlier upload.
  if (process.env.GITHUB_ACTIONS) return []
  const root = await gitRoot(run)
  if (!root || !existsSync(join(root, WORKFLOW))) return []
  return uploadedRuns(basename(WORKFLOW, '.yml'), run).catch((e: unknown) => {
    warnRemote(e)
    return []
  })
}

function warnRemote(e: unknown) {
  const { stderr, message } = e as { stderr?: string; message?: string }
  const reason = (stderr || message || String(e)).trim().split('\n')[0]
  console.error(`warning: runs on GitHub left out: ${reason}`)
}
