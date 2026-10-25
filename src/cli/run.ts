import { existsSync } from 'node:fs'
import { appendFile, mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { styleText } from 'node:util'
import { type Command, Option } from 'commander'
import { configPath, loadConfig } from '../config/load.js'
import {
  approvalsPath,
  attemptsPath,
  remoteDir,
  runLockPath,
  runsDir,
  skillsDirOf,
  watchLockPath,
} from '../config/paths.js'
import type { Config } from '../config/schema.js'
import { clearApprovals, loadApprovals, saveApprovals } from '../core/approvals.js'
import { loadAttempts, recordAttempts, saveAttempts } from '../core/attempts.js'
import { isolateFor } from '../core/launch.js'
import {
  type Chain,
  chains,
  counted,
  formatReport,
  localTime,
  type RunReport,
  runLine,
} from '../core/report.js'
import { pruneRuns } from '../core/retention.js'
import { lockHolder, takeRunLock } from '../core/run-lock.js'
import { unitStats } from '../core/stats.js'
import { describeWindow, hostedEnd, runEnd } from '../core/window.js'
import { fetchRun, type UploadedRun, uploadedRuns } from '../forge/artifacts.js'
import { type Exec, exec } from '../forge/gh.js'
import { forgeFor } from '../forge/index.js'
import { providersOf } from '../providers/index.js'
import { WORKFLOW } from '../scheduler/github-actions.js'
import { notifyRun } from '../worker/notify.js'
import { maskSecrets } from '../worker/setup.js'
import { namedChains, runUnits } from '../worker/units.js'
import { type ItemCommands, interactive, itemCommands, openScreen, type Screen } from './browse.js'
import { reportConfigError } from './config.js'
import {
  ambiguous,
  findChains,
  formatPlan,
  formatRun,
  formatSkipped,
  formatUnit,
  listedUnits,
  reportJson,
  summarize,
} from './format.js'
import { probeAndPlan, ruleNumber, skipKinds } from './plan.js'
import { gitRoot } from './schedule.js'
import { configuredSources } from './skip.js'
import { unitsFile } from './stats.js'
import { type OnProgress, runTriage, type UnitFiles } from './triage.js'

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
    .description('plan the units, start a worker per unit and publish PRs and reports')
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
        await isolateFor(config.isolation, process.env)
        const now = new Date()
        const until = opts.scheduled
          ? runEnd(config.windows, now, process.env)
          : hostedEnd(now, process.env)
        if (opts.scheduled && !until) {
          console.log(
            config.windows.length
              ? `Outside the windows (${config.windows.map(describeWindow).join(', ')}), nothing to do`
              : 'No windows, nothing to do',
          )
          return
        }
        const runId = newRunId()
        if (!opts.dryRun) {
          const lock = await takeRunLock(runLockPath, runId)
          if (!('release' in lock)) {
            console.error(
              lock.pid === (await lockHolder(watchLockPath))
                ? `awaywork watch is running run ${lock.runId} (pid ${lock.pid}); try again once it ends`
                : `already running (pid ${lock.pid}, run ${lock.runId}); if that is stale, delete ${runLockPath}`,
            )
            process.exitCode = 1
            return
          }
          release = lock.release
          await pruneOld(config, now, consoleLog)
        }
        const ran = await executeRun({
          ...opts,
          path,
          config,
          runId,
          now,
          until,
          log: consoleLog,
          signal: () => {
            const abort = new AbortController()
            for (const signal of ['SIGINT', 'SIGTERM'] as const) {
              process.once(signal, () => abort.abort())
            }
            return abort.signal
          },
        })
        if (!ran) process.exitCode = 1
      } catch (e) {
        reportConfigError(e)
      } finally {
        await release?.()
      }
    })

  program
    .command('report [id]')
    .description("print a run's morning report, the latest by default; browsable in a terminal")
    .option('--list', 'list the last 20 runs: units, PRs and reports')
    .addOption(
      new Option('--json', "print the run's results as JSON instead of the text").conflicts('list'),
    )
    .addOption(
      new Option(
        '--unit <n|key>',
        'show one unit in full, by its number in the report, unit id or item key',
      ).conflicts(['list', 'json']),
    )
    .addOption(
      new Option('--skipped [kind]', 'list the skipped items, or those of one kind')
        .choices(skipKinds)
        .conflicts(['list', 'json', 'unit']),
    )
    .action(async (id: string | undefined, opts: ReportOptions) => {
      const browsing = interactive() && !opts.list && !opts.json && !opts.unit && !opts.skipped
      const screen = browsing ? openScreen('Loading the report') : undefined
      try {
        await printReport(id, !!opts.list, exec, !!opts.json, {
          ...opts,
          browse: screen && { screen, commands: itemCommands(() => configuredSources(program)) },
        })
      } finally {
        screen?.close()
      }
    })
}

/** Where a run's lines go: the terminal for `awaywork run`, log files for `awaywork watch`. */
export interface RunLog {
  /** A line `awaywork run` prints; `event` marks the run's and each unit's start and end. */
  info(line: string, event?: boolean): void
  error(line: string): void
}

const consoleLog: RunLog = {
  info: (line) => console.log(line),
  error: (line) => console.error(line),
}

/** A run's id: its start in UTC, as `YYYYMMDD-HHMMSS`. */
export const newRunId = () =>
  new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15)

/** Removes the run dirs older than `keep_runs`, saying how many went. */
export async function pruneOld(config: Config, now: Date, log: RunLog): Promise<void> {
  const pruned = await pruneRuns(config, now)
  for (const failure of pruned.failures) log.error(`warning: ${failure}`)
  if (pruned.removed)
    log.info(
      `Removed ${counted(pruned.removed, 'run')} older than ${config.keep_runs}, ${(pruned.bytes / 2 ** 20).toFixed(1)} MB freed`,
      true,
    )
}

export interface RunArgs extends Pick<RunOptions, 'dryRun' | 'unit' | 'repo' | 'rule'> {
  path: string
  config: Config
  runId: string
  now: Date
  until?: Date
  log: RunLog
  /** The signal stopping the units, asked for as they start. */
  signal: () => AbortSignal
}

/**
 * Plans and runs the units, writes the run's report, attempts and approvals, and notifies;
 * false when the options name no unit. The caller holds the run lock.
 */
export async function executeRun(a: RunArgs): Promise<boolean> {
  const { config, path, runId, log } = a
  const { plan, warnings, ctx, sources, secrets } = await probeAndPlan(config, skillsDirOf(path), {
    retry: !!a.unit,
    repo: a.repo,
    rule: a.rule,
    at: a.now,
  })
  for (const warning of warnings) log.error(`warning: ${warning.replaceAll('\n', '\n  ')}`)
  const named = a.unit ? namedChains(plan, a.unit) : []
  if (a.unit && named.length !== 1) {
    log.error(
      named.length
        ? ambiguous(
            a.unit,
            named.flatMap((p) => p.unit.items.slice(0, 1)),
          )
        : `no unit "${a.unit}" in this run's plan; awaywork plan lists them`,
    )
    return false
  }
  if (!plan.units.length && (a.repo !== undefined || a.rule !== undefined)) {
    log.error('no unit matches --repo/--rule; awaywork plan lists them')
    return false
  }
  const runDir = join(runsDir, runId)
  await mkdir(runDir, { recursive: true, mode: 0o700 })
  if (process.env.GITHUB_OUTPUT)
    await appendFile(process.env.GITHUB_OUTPUT, `run-id=${runId}\nrun-dir=${runDir}\n`)
  const skipped = plan.skipped.length > 0 ? `\n${formatSkipped(plan.skipped)}\n` : ''
  await writeFile(join(runDir, 'plan.txt'), `${formatPlan(plan, warnings)}\n${skipped}`)
  log.info(
    `Run ${runId}: ${counted(listedUnits(plan).length, 'unit')} planned, state in ${runDir}`,
    true,
  )

  const report = await runUnits({
    config,
    configDir: dirname(path),
    plan,
    runId,
    runDir,
    dryRun: !!a.dryRun,
    only: a.unit,
    until: a.until,
    providers: providersOf(config),
    sources,
    forge: forgeFor(config),
    ctx: { ...ctx, log: (line) => log.info(`  ${line}`) },
    event: (line) => log.info(`  ${line}`, true),
    signal: a.signal(),
    attempts: await loadAttempts(attemptsPath),
  })
  const reportPath = join(runDir, 'report.md')
  await writeFile(reportPath, formatReport(report, warnings))
  await writeFile(join(runDir, reportJsonFile), reportJson(report, warnings))
  await writeFile(join(runDir, unitsFile), JSON.stringify(unitStats(report.results)))
  await saveAttempts(attemptsPath, recordAttempts(await loadAttempts(attemptsPath), report))
  await saveApprovals(approvalsPath, clearApprovals(await loadApprovals(approvalsPath), report))
  log.info(summarize(report, reportPath), true)
  if (interactive()) log.info(styleText('dim', 'awaywork report browses this run'))
  if (config.notify) {
    const failure = await notifyRun(config.notify.command, { path: reportPath, runId })
    if (failure) log.error(`notify failed: ${maskSecrets(failure, secrets, ctx.env)}`)
  }
  return true
}

type ReportOptions = {
  list?: boolean
  json?: boolean
  unit?: string
  skipped?: string | true
  /** Browse the run on this screen, already open, instead of printing it. */
  browse?: { screen: Screen; commands: ItemCommands }
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
  view: Pick<ReportOptions, 'unit' | 'skipped' | 'browse'> = {},
) {
  const screen = view.browse?.screen
  // Kept off the screen: they go in the view's warnings, or out once it's closed.
  const held: string[] = []
  const warn = (e: unknown) => (screen ? held.push(remoteWarning(e)) : warnRemote(e))
  const local = (await readdir(runsDir).catch(() => [])).sort()
  const uploaded = id && local.includes(id) ? [] : await remoteRuns(run, warn, screen?.progress)
  const runs: Run[] = [
    ...local.map((id) => ({ id, dir: join(runsDir, id) })),
    ...uploaded
      .filter((r) => !local.includes(r.id))
      .map((r) => ({ id: r.id, dir: join(remoteDir, r.repo, r.artifact), uploaded: r })),
  ].sort((a, b) => a.id.localeCompare(b.id))
  const read = (r: Run, file = json ? reportJsonFile : 'report.md') =>
    readFile(join(r.dir, file), 'utf8').catch(() => undefined)

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
  if (picked?.uploaded) {
    const name = `run ${picked.id}`
    screen?.progress({ name, state: 'running', detail: 'fetching from GitHub' })
    try {
      await fetchRun(picked.uploaded, picked.dir, run)
      screen?.progress({ name, state: 'done', detail: 'fetched from GitHub' })
    } catch (e) {
      warn(e)
      screen?.progress({ name, state: 'failed', detail: remoteReason(e) })
      picked = id ? undefined : runs.findLast((r) => !r.uploaded)
    }
  }
  const results = !json && picked ? await read(picked, reportJsonFile) : undefined
  if (results !== undefined && picked)
    return printRun(picked.dir, JSON.parse(results), view, !!picked.uploaded, held)
  screen?.close()
  for (const warning of held) console.error(`warning: ${warning}`)
  const which = id ?? picked?.id
  if (!which) {
    console.error(`no runs in ${runsDir}`)
    process.exitCode = 1
    return
  }
  if (view.unit || view.skipped) {
    console.error(`run ${which} has no ${reportJsonFile}, which --unit and --skipped read`)
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
  } else console.log(text)
}

/** A run from its report.json: the whole run, browsed or printed, one unit with the files it left, or its skipped items. */
async function printRun(
  dir: string,
  report: RunReport & { warnings?: string[] },
  view: Pick<ReportOptions, 'unit' | 'skipped' | 'browse'>,
  remote: boolean,
  held: string[] = [],
) {
  if (view.skipped)
    return console.log(
      formatSkipped(report.plan.skipped, view.skipped === true ? undefined : view.skipped),
    )
  if (!view.unit && view.browse) {
    const units = await Promise.all(
      chains(report).map((chain, i) => unitFiles(dir, { chain, n: i + 1 })),
    )
    const warnings = [...held, ...(report.warnings ?? [])]
    const state = runTriage(report, warnings, units, process.stdout.rows, remote)
    return view.browse.screen.browse(state, view.browse.commands)
  }
  if (!view.unit) return console.log(formatRun(report, report.warnings, true))
  const named = findChains(report, view.unit)
  const [found] = named
  if (!found || named.length > 1) {
    const tops = named.flatMap(({ chain }) => chain.head.planned.unit.items.slice(0, 1))
    console.error(
      found
        ? ambiguous(view.unit, tops)
        : `no unit "${view.unit}" in run ${report.runId}; awaywork report lists them`,
    )
    process.exitCode = 1
    return
  }
  console.log((await unitFiles(dir, found)).text)
}

/** A unit's `--unit` text, and the worker.log and diff it left that are still there. */
async function unitFiles(dir: string, found: { chain: Chain; n: number }): Promise<UnitFiles> {
  const there = (file: string | undefined) =>
    file && existsSync(join(dir, file)) ? join(dir, file) : undefined
  const { head, steps } = found.chain
  const files = steps.flatMap((s) => Object.values(s.files ?? {}).flatMap((f) => there(f) ?? []))
  const bodyFile = there(head.files?.sliceBody) ?? there(head.files?.report)
  const outcomeText = head.outcome && 'text' in head.outcome ? head.outcome.text : undefined
  const body = bodyFile ? await readFile(bodyFile, 'utf8') : outcomeText
  return {
    text: formatUnit(found, [...new Set(files)], body, true),
    // The last step that ran is the one that ended the chain.
    log: steps.map((s) => there(s.files?.log)).findLast(Boolean),
    diff: [head.files?.sliceDiff, ...steps.map((s) => s.files?.diff)].map(there).find(Boolean),
  }
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
async function remoteRuns(
  run: Exec,
  warn = warnRemote,
  onProgress?: OnProgress,
): Promise<UploadedRun[]> {
  // A runner's own report is of the run it just made, never of an earlier upload.
  if (process.env.GITHUB_ACTIONS) return []
  const root = await gitRoot(run)
  if (!root || !existsSync(join(root, WORKFLOW))) return []
  const name = 'runs on GitHub'
  onProgress?.({ name, state: 'running' })
  return uploadedRuns(basename(WORKFLOW, '.yml'), run).then(
    (runs) => {
      onProgress?.({ name, state: 'done', detail: counted(runs.length, 'run') })
      return runs
    },
    (e: unknown) => {
      warn(e)
      onProgress?.({ name, state: 'failed', detail: remoteReason(e) })
      return []
    },
  )
}

function remoteReason(e: unknown): string {
  const { stderr, message } = e as { stderr?: string; message?: string }
  return (stderr || message || String(e)).trim().split('\n')[0] ?? ''
}

const remoteWarning = (e: unknown) => `runs on GitHub left out: ${remoteReason(e)}`

function warnRemote(e: unknown) {
  console.error(`warning: ${remoteWarning(e)}`)
}
