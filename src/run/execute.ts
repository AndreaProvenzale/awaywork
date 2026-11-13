import { spawn } from 'node:child_process'
import { closeSync, openSync } from 'node:fs'
import { appendFile, mkdir, rm, rmdir, writeFile } from 'node:fs/promises'
import { constants } from 'node:os'
import { dirname, join } from 'node:path'
import { styleText } from 'node:util'
import { reportJson } from '../cli/format/json.js'
import { formatPlan, listedUnits } from '../cli/format/plan.js'
import { summarize } from '../cli/format/report.js'
import { formatSkipped } from '../cli/format/skips.js'
import { ambiguous } from '../cli/format/why.js'
import { attemptsPath, runsDir, skillsDirOf } from '../config/paths.js'
import type { Config } from '../config/schema.js'
import { loadSkills } from '../config/skills.js'
import { builtinSkills, pickRefusal, resolveSkill } from '../core/skills.js'
import { forgeFor } from '../forge/index.js'
import { loadAttempts, recordAttempts, saveAttempts } from '../plan/attempts.js'
import { isNamed, type PlannedUnit, type RunPlan } from '../plan/foreman.js'
import { probeAndPlan } from '../plan/probe.js'
import { ruleFor } from '../plan/queue.js'
import { counted, formatReport } from '../posts/report.js'
import { providersOf } from '../providers/index.js'
import { type Allowance, route } from '../quota/budget.js'
import { notifyRun } from '../worker/notify.js'
import { maskSecrets } from '../worker/setup.js'
import { namedChains, type RunInput, runUnits } from '../worker/units.js'
import { pruneRuns } from './retention.js'
import { unitStats, unitsFile } from './stats.js'

export type RunOptions = {
  dryRun?: boolean
  unit?: string
  repo?: string
  rule?: number
  scheduled?: boolean
  detach?: boolean
  skill?: string
}

/** What a `--detach` child tells the parent waiting on it, once. */
type Said = { started: true } | { refused: string }

// Hands the child its run id: the parent has already made its run dir and log.
export const DETACHED_RUN = 'AWAYWORK_DETACHED_RUN'

/** Where a run's lines go: the terminal for `awaywork run`, log files for `awaywork watch`. */
export interface RunLog {
  /** A line `awaywork run` prints; `event` marks the run's and each unit's start and end. */
  info(line: string, event?: boolean): void
  error(line: string): void
}

/** A signal aborted by the first SIGINT or SIGTERM, which still exits 128+n once done; a second one quits at once. */
export function abortOnSignals(): AbortSignal {
  const abort = new AbortController()
  // `on`, not `once`: execa's signal-exit re-raises a signal it sees no other listener for.
  for (const signal of ['SIGINT', 'SIGTERM'] as const)
    process.on(signal, () => {
      if (abort.signal.aborted) process.exit(128 + constants.signals[signal])
      process.exitCode = 128 + constants.signals[signal]
      abort.abort()
    })
  return abort.signal
}

/** Tells the `--detach` parent what became of the run, the first report only, then lets go of it. */
export function tellParent() {
  let told = false
  return (said: Said) => {
    if (told) return
    told = true
    process.send?.(said, undefined, undefined, () => {
      if (process.connected) process.disconnect()
    })
  }
}

/**
 * Starts this `run --unit` again as a process of its own, its output in its run's `run.log`, and
 * says what that process reported about the unit; its exit code. The process outlives this one.
 */
export async function detachRun(unit: string): Promise<number> {
  await mkdir(runsDir, { recursive: true, mode: 0o700 })
  const runId = newRunId()
  const runDir = join(runsDir, runId)
  try {
    await mkdir(runDir, { mode: 0o700 })
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e
    console.error('a run started this very second; try again')
    return 1
  }
  const logPath = join(runDir, 'run.log')
  const log = openSync(logPath, 'a')
  const child = spawn(
    process.execPath,
    [
      ...process.execArgv,
      process.argv[1] as string,
      ...process.argv.slice(2).filter((arg) => arg !== '--detach'),
    ],
    {
      detached: true,
      stdio: ['ignore', log, log, 'ipc'],
      env: { ...process.env, [DETACHED_RUN]: runId },
    },
  )
  closeSync(log)
  // A disconnect, not an exit: it can't overtake a report the child sent as it ended.
  const said = await new Promise<Said | undefined>((done) => {
    child.once('message', (m) => done(m as Said))
    child.once('disconnect', () => done(undefined))
    child.once('error', () => done(undefined))
  })
  if (child.connected) child.disconnect()
  child.unref()
  if (!said) {
    console.error(`the run stopped before it said whether ${unit} started; see ${logPath}`)
    return 1
  }
  if ('refused' in said) {
    console.error(said.refused)
    // Not the whole dir: it may be another run's, started in the same second.
    await rm(logPath, { force: true })
    await rmdir(runDir).catch(() => {})
    return 1
  }
  console.log(detachedLine(unit, runId))
  return 0
}

/** What `run --detach` says once the unit started. */
export const detachedLine = (unit: string, runId: string) =>
  `Started ${unit} as run ${runId}; awaywork report ${runId} shows it once it ends`

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

export interface RunArgs extends Pick<RunOptions, 'dryRun' | 'unit' | 'repo' | 'rule' | 'skill'> {
  path: string
  config: Config
  runId: string
  now: Date
  until?: Date
  log: RunLog
  /** Says `awaywork report` browses the run, after its summary. */
  browseHint?: boolean
  /** The signal stopping the units, asked for as they start. */
  signal: () => AbortSignal
  /** Whether you're around: else decided from `now` and the windows. */
  present?: boolean
  /** A `run: soon` run: its rules over these sources, these units, and no end-of-run notify. */
  soon?: { sources: string[]; units: string[] }
  /** Takes the planned units from the daemon's other runs, returning the plan this run runs. */
  claim?: (plan: RunPlan) => RunPlan
  turn?: RunInput['turn']
  /** For `--detach`: told once whether the named unit starts, before it does. */
  tell?: (said: Said) => void
}

/** Runs each function it's given once the ones before it have settled. */
export function serial() {
  let last: Promise<unknown> = Promise.resolve()
  return <T>(f: () => Promise<T>): Promise<T> => {
    const next = last.then(f)
    last = next.catch(() => {})
    return next
  }
}

// Two of the daemon's runs ending together would each overwrite the other's attempts.
const inSaving = serial()

/**
 * Plans and runs the units, writes the run's report and attempts, and notifies, a soon
 * run per unit only; false when the options name no unit. The caller holds the run lock.
 */
/** A plan warning as `run` logs it, its later lines indented under the first. */
export const warningLine = (w: string) => `warning: ${w.replaceAll('\n', '\n  ')}`

export async function executeRun(a: RunArgs): Promise<boolean> {
  const { config, path, runId, log } = a
  const badSkill = a.skill !== undefined && (await skillRefusal(a.skill, skillsDirOf(path)))
  if (badSkill) {
    log.error(badSkill)
    a.tell?.({ refused: badSkill })
    return false
  }
  const planned = await probeAndPlan(config, skillsDirOf(path), {
    unit: a.unit,
    skill: a.skill,
    repo: a.repo,
    rule: a.rule,
    at: a.now,
    present: a.present,
    soon: a.soon,
    moves: { dryRun: !!a.dryRun, log: (line) => log.info(`  ${line}`, true) },
  })
  const { warnings, ctx, sources, secrets } = planned
  const warned = warnings.map(warningLine)
  for (const line of warned) log.error(line)
  const refuse = (why: string) => {
    log.error(why)
    a.tell?.({ refused: [why, ...warned].join('\n') })
    return false
  }
  const noOneOff = a.unit && a.skill && oneOffRefusal(planned.plan, a.unit)
  if (noOneOff) return refuse(noOneOff)
  const named = a.unit ? namedChains(planned.plan, a.unit) : []
  if (a.unit && named.length !== 1)
    return refuse(
      named.length
        ? ambiguous(
            a.unit,
            named.flatMap((p) => p.unit.items.slice(0, 1)),
          )
        : `no unit "${a.unit}" in this run's plan; awaywork plan lists them`,
    )
  if (a.tell && named[0]) {
    const idle = wontStart(named[0], planned.plan.allowances)
    if (idle) return refuse(idle)
    a.tell({ started: true })
  }
  if (!planned.plan.units.length && (a.repo !== undefined || a.rule !== undefined)) {
    log.error('no unit matches --repo/--rule; awaywork plan lists them')
    return false
  }
  const plan = a.claim ? a.claim(planned.plan) : planned.plan
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
    // Claimed first by a run in progress, it's in the plan's skipped, and this run runs nothing.
    only: a.unit && namedChains(plan, a.unit).length ? a.unit : undefined,
    until: a.until,
    providers: providersOf(config),
    sources,
    forge: forgeFor(config),
    ctx: { ...ctx, log: (line) => log.info(`  ${line}`) },
    event: (line) => log.info(`  ${line}`, true),
    signal: a.signal(),
    attempts: await loadAttempts(attemptsPath),
    turn: a.turn,
    soon: !!a.soon,
  })
  const reportPath = join(runDir, 'report.md')
  await writeFile(reportPath, formatReport(report, warnings))
  await writeFile(join(runDir, reportJsonFile), reportJson(report, warnings))
  await writeFile(join(runDir, unitsFile), JSON.stringify(unitStats(report.results)))
  await inSaving(async () => {
    await saveAttempts(attemptsPath, recordAttempts(await loadAttempts(attemptsPath), report))
  })
  log.info(summarize(report, reportPath), true)
  if (a.browseHint) log.info(styleText('dim', 'awaywork report browses this run'))
  if (config.notify && !a.soon) {
    const failure = await notifyRun(config.notify.command, { path: reportPath, runId })
    if (failure) log.error(`notify failed: ${maskSecrets(failure, secrets, ctx.env)}`)
  }
  return true
}

/** Why `--skill` can't name this skill: it's unknown, or a rule or a gate is what runs it. */
export async function skillRefusal(name: string, userSkillsDir: string) {
  const catalog = { user: await loadSkills(userSkillsDir), builtin: builtinSkills }
  return pickRefusal(name, resolveSkill(name, catalog)?.meta)
}

/** Why `--skill` can't take what `name` names: a rule does, or the planner refused the one-off; undefined when it can, or when `name` names nothing it can tell. */
export function oneOffRefusal(plan: RunPlan, name: string): string | undefined {
  const taken = (rule: number, key: string) =>
    `--skill is only for an item no rule takes: #${rule + 1} ${plan.queue[rule]?.skill} takes ${key}`
  const chains = namedChains(plan, name)
  if (chains.length > 1) return undefined
  const [chain] = chains
  if (chain) return chain.unit.oneOff ? undefined : taken(chain.rule, name)
  const [skip, ...more] = plan.skipped.filter((s) => isNamed(s.item, name))
  if (!skip || more.length) return undefined
  const rule = ruleFor(plan.queue, skip.item)
  return rule >= 0 ? taken(rule, skip.item.key) : skip.reason
}

/** Why running only `head`'s chain now would do nothing, as `runUnits` will decide it; undefined when it can start. */
function wontStart(head: PlannedUnit, allowances: Record<string, Allowance>): string | undefined {
  if (head.after || head.waitsFor?.length)
    return `${head.unit.id} waits for another task's PR, which this run won't open`
  if (head.unit.merge) return undefined
  const { provider, passed } = route(head.unit.providers, allowances, {})
  if (!provider) return `no provider left: ${passed.join('; ') || 'none configured'}`
  return head.quotaUnmet && `the rule's quota \`when\` won't hold: ${head.quotaUnmet}`
}

export const reportJsonFile = 'report.json'
