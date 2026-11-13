import { existsSync } from 'node:fs'
import { readdir, readFile, stat } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { type Command, Option } from 'commander'
import { ConfigError, configPath, loadConfig } from '../../config/load.js'
import { remoteDir, runLockPath, runsDir, watchLockPath } from '../../config/paths.js'
import { isolateFor } from '../../core/isolation.js'
import { fetchRun, type UploadedRun, uploadedRuns } from '../../forge/artifacts.js'
import { type Exec, exec, gitRoot } from '../../forge/gh.js'
import type { OnProgress } from '../../plan/probe.js'
import {
  type Chain,
  chains,
  counted,
  localTime,
  type RunReport,
  runLine,
} from '../../posts/report.js'
import { describeWindow, hostedEnd, runEnd } from '../../quota/window.js'
import {
  abortOnSignals,
  DETACHED_RUN,
  detachRun,
  executeRun,
  newRunId,
  pruneOld,
  type RunLog,
  type RunOptions,
  reportJsonFile,
  tellParent,
} from '../../run/execute.js'
import { lockHolder, takeRunLock } from '../../run/run-lock.js'
import { WORKFLOW } from '../../scheduler/github-actions.js'
import { reportConfigError } from '../format/ask.js'
import { reportJson } from '../format/json.js'
import { findChains, formatRun, formatUnit } from '../format/report.js'
import { formatSkipped } from '../format/skips.js'
import { ambiguous } from '../format/why.js'
import {
  type ItemCommands,
  interactive,
  itemCommands,
  openScreen,
  type Screen,
} from '../tui/browse.js'
import { runTriage, type UnitFiles } from '../tui/triage.js'
import { ruleNumber, skipKinds } from './plan.js'

export function runCommand(program: Command): void {
  program
    .command('run')
    .description('plan the units, start a worker per unit and publish PRs and reports')
    .option('--dry-run', 'prepare each workspace (clone, context, prompt) but run no worker')
    .option('--unit <id>', 'run only this unit, by id or item key')
    .option('--repo <glob>', 'run only units in repos matching owner/name, * globs')
    .option('--rule <n>', 'run only units of this queue rule, counted from 1', ruleNumber)
    .option('--scheduled', 'run only inside a window and start no unit after it ends')
    .addOption(
      new Option(
        '--detach',
        'with --unit: return once the unit has started, leaving it running',
      ).conflicts('scheduled'),
    )
    .option('--skill <name>', 'with --unit, on an item no rule takes: run this skill on it, once')
    .action(async (opts: RunOptions) => {
      if (opts.skill !== undefined && !opts.unit) {
        console.error('--skill needs --unit <id>')
        process.exitCode = 1
        return
      }
      if (opts.detach) {
        if (opts.unit) process.exitCode = await detachRun(opts.unit)
        else {
          console.error('--detach needs --unit <id>')
          process.exitCode = 1
        }
        return
      }
      // Off the environment at once, so nothing this run starts reads it.
      const detachedId = process.env[DETACHED_RUN]
      delete process.env[DETACHED_RUN]
      const tell = detachedId ? tellParent() : undefined
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
        const runId = detachedId ?? newRunId()
        if (!opts.dryRun) {
          const lock = await takeRunLock(runLockPath, runId)
          if (!('release' in lock)) {
            const held =
              lock.pid === (await lockHolder(watchLockPath))
                ? `awaywork watch holds the run lock (pid ${lock.pid}); try again once its runs end, awaywork schedule status lists them`
                : `already running (pid ${lock.pid}, run ${lock.runId}); if that is stale, delete ${runLockPath}`
            console.error(held)
            tell?.({ refused: held })
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
          browseHint: interactive(),
          signal: abortOnSignals,
          tell,
        })
        if (!ran) process.exitCode = 1
      } catch (e) {
        // The path and first problem on one line: the pane shows only that.
        if (e instanceof ConfigError) tell?.({ refused: e.message.replace(':\n  ', ': ') })
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
          browse: screen && {
            screen,
            commands: itemCommands(() => loadConfig(configPath(program.opts().config))),
          },
        })
      } finally {
        screen?.close()
      }
    })
}

const consoleLog: RunLog = {
  info: (line) => console.log(line),
  error: (line) => console.error(line),
}

type ReportOptions = {
  list?: boolean
  json?: boolean
  unit?: string
  skipped?: string | true
  /** Browse the run on this screen, already open, instead of printing it. */
  browse?: { screen: Screen; commands: ItemCommands }
}

interface Run {
  id: string
  dir: string
  uploaded?: UploadedRun
}

/** A run's `report --list` line, tagged with the workflow that uploaded it. */
export const listedRun = (
  id: string,
  report: string | undefined,
  uploaded?: Pick<UploadedRun, 'workflow'>,
) => runLine(id, report) + (uploaded ? `  (github: ${uploaded.workflow})` : '')

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
    for (const r of last) console.log(listedRun(r.id, await read(r), r.uploaded))
    return
  }
  // A run still going, or one that died, has no report.json: the last one that does stands for what reads it.
  const readsResults = json || !!view.unit || !!view.skipped
  const latest = (from: Run[]) =>
    readsResults
      ? from.findLast((r) => r.uploaded || existsSync(join(r.dir, reportJsonFile)))
      : from.at(-1)
  let picked = id ? runs.find((r) => r.id === id) : latest(runs)
  if (picked?.uploaded) {
    const name = `run ${picked.id}`
    screen?.progress({ name, state: 'running', detail: 'fetching from GitHub' })
    try {
      await fetchRun(picked.uploaded, picked.dir, run)
      screen?.progress({ name, state: 'done', detail: 'fetched from GitHub' })
    } catch (e) {
      warn(e)
      screen?.progress({ name, state: 'failed', detail: remoteReason(e) })
      picked = id ? undefined : latest(runs.filter((r) => !r.uploaded))
    }
  }
  const results = !json && picked ? await read(picked, reportJsonFile) : undefined
  if (results !== undefined && picked)
    return printRun(picked.dir, JSON.parse(results), view, !!picked.uploaded, held)
  screen?.close()
  for (const warning of held) console.error(`warning: ${warning}`)
  const which = id ?? picked?.id
  if (!which) {
    const going = readsResults && runs.findLast((r) => !r.uploaded)
    console.error(
      going
        ? `no finished run yet: run ${going.id} is going, or stopped without a report`
        : `no runs in ${runsDir}`,
    )
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
  } else console.log(json ? reflagged(text) : text)
}

/** A report.json through `reportJson` again, so a run an older awaywork wrote gets `needsYou` too. */
function reflagged(text: string) {
  const report = JSON.parse(text)
  return reportJson(report, report.warnings)
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
