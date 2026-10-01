import { createWriteStream } from 'node:fs'
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { execa } from 'execa'
import type { Config } from '../config/schema.js'
import { route, withQuota } from '../core/budget.js'
import { describeCondition, type Facts, holds } from '../core/condition.js'
import { type NightPlan, slug } from '../core/foreman.js'
import type { NightReport, UnitResult } from '../core/report.js'
import type { Condition, Ctx, Forge, Provider, Quota, Source, Unit } from '../core/types.js'
import { type Outcome, publish } from './publish.js'
import { runWorker, type WorkerOptions } from './run.js'
import { runCommand, runSetup } from './setup.js'
import {
  notSymlink,
  prepareWorkspace,
  readOutput,
  refuseSymlinks,
  WORK_DIR,
  workerEnv,
  writeOutput,
} from './workspace.js'

const MAX_TURNS = 200
const CHECK_LOG_CHARS = 8000

export interface NightInput {
  config: Config
  configDir: string
  plan: NightPlan
  runId: string
  runDir: string
  dryRun: boolean
  /** Run only this unit, named by its id or an item key, in any case. */
  only?: string
  /** Start no unit from this time on, and stop the running one at it. */
  until?: Date
  providers: Record<string, Provider>
  sources: Record<string, Source>
  forge: Forge
  ctx: Ctx
  signal?: AbortSignal
  watch?: WorkerOptions['watch']
  skillDirs?: { user: string; builtin: string }
}

/**
 * Runs the plan's units one at a time, re-routing as windows fill, and publishes each.
 * A draft PR stacks on tonight's draft PR it follows, or on its repo's last one when it would start from the default branch.
 * Every unit leaves `units/<id>/` in the run dir: its context, prompt, output and worker log.
 */
export async function runNight(n: NightInput): Promise<NightReport> {
  const startedAt = new Date()
  const allowances = { ...n.plan.allowances }
  const routed: Record<string, number> = {}
  const quotas: Record<string, Quota> = {}
  const results: UnitResult[] = []
  const only = n.only && slug(n.only)
  const wanted = new Set(
    n.plan.units
      .filter((p) => p.unit.id === only || p.unit.items.some((i) => slug(i.key) === only))
      .map((p) => p.unit.id),
  )
  if (n.only && wanted.size === 0) throw new Error(`no unit "${n.only}" in tonight's plan`)
  // A loop round needs its whole loop, and a chained unit the units it follows.
  for (let size = 0; size !== wanted.size; ) {
    size = wanted.size
    for (const p of n.plan.units) {
      if (p.loop && wanted.has(p.unit.id)) wanted.add(p.loop.host)
      if (p.loop && wanted.has(p.loop.host)) wanted.add(p.unit.id)
      if (p.after && wanted.has(p.unit.id)) wanted.add(p.after)
    }
  }
  const planned = n.plan.units.filter((p) => !only || wanted.has(p.unit.id))
  const secrets = [
    ...Object.values(n.providers).flatMap((p) => p.secrets),
    ...Object.entries(n.config.sources).flatMap(([id, cfg]) => n.sources[id]?.secrets(cfg) ?? []),
    ...(n.config.notify?.secrets ?? []),
    ...Object.values(n.config.repos).flatMap((r) => r.secrets),
  ]

  // Tonight's draft PRs by repo and branch, and the branch on top of each repo's stack.
  const opened: Record<string, string> = {}
  const tips: Record<string, string> = {}
  const hosts = new Set(planned.flatMap((p) => (p.loop ? [p.loop.host] : [])))
  // The base each unit ran on: a step after one that opened no PR runs there too.
  const ranOn: Record<string, string> = {}
  let open: OpenLoop | undefined
  // A step skipped by its `when` stands for the unit it followed, and the base a step after that starts from.
  const standIns: Record<string, { result: UnitResult; base: string }> = {}
  // The branch each unit's chain started its commits from, which `changed` diffs against.
  const starts: Record<string, string> = {}
  const checks = new Map<string, Check>()
  // What each clone had uncommitted before a worker could leave anything: setup's and the checks' leftovers.
  const baselines = new Map<string, Set<string>>()
  // A loop's latest verdict by its host, for the `when` of the step after it.
  const loopVerdicts: Record<string, string> = {}

  /** Whether `r`, or a unit of the chain before it, opened a draft PR. */
  const openedPr = (r: UnitResult | undefined): boolean =>
    !!r &&
    (r.outcome?.kind === 'pr' ||
      openedPr(results.find((x) => r.planned.after && x.planned.unit.id === r.planned.after)))

  /** Runs a condition's command in the clone outside the model, once per commit, with none of the secrets. */
  const check = async (
    command: string,
    unit: Unit,
    dir: string,
    log: (line: string) => void,
  ): Promise<Check> => {
    if (unit.untrusted) return refusal("not run on an untrusted author's PR")
    // The worker's sandbox is the provider's: night-shift has none to run worker-written code in.
    if (!unit.network) return refusal('not run without network: it has no sandbox')
    // The published branch holds only commits, so a check must not pass on files left uncommitted.
    const baseline = baselines.get(dir)
    const left = (await uncommitted(dir)).filter((line) => !baseline?.has(line))
    if (left.length) return { output: left.join('\n'), failed: 'uncommitted changes in the clone' }
    const key = `${dir} ${await head(dir)} ${command}`
    const known = checks.get(key)
    if (known) return known
    const result = await runCommand(command, dir, setupEnv(n.ctx.env, dir, secrets, []), {
      secrets: [],
      signal: n.signal,
      until: n.until,
    })
    log(`check ${command}: ${result.failed ?? 'passed'}${result.output && `\n${result.output}`}`)
    baselines.set(dir, new Set(await uncommitted(dir)))
    if (!result.stopped) checks.set(key, result)
    return result
  }

  /** What `condition` needs to know about the clone; a command's output goes to `logFile`. */
  const factsFor = async (
    condition: Condition,
    unit: Unit,
    dir: string,
    verdict: string | undefined,
    log: (line: string) => void,
    logFile: string,
  ) => {
    const facts: Facts = { verdict }
    let ran: RanCheck | undefined
    if (condition.command) {
      ran = { command: condition.command, ...(await check(condition.command, unit, dir, log)) }
      facts.command = !ran.failed
      await mkdir(dirname(logFile), { recursive: true })
      await writeFile(logFile, checkLog(ran))
    }
    if (condition.changed) facts.changed = await changes(dir, condition.changed, starts[unit.id])
    return { facts, check: ran }
  }

  /** Publishes the loop's clone once, as its host's draft PR, with how the loop went. */
  const closeLoop = async (loop: OpenLoop) => {
    open = undefined
    const { host, unit, dir } = loop
    host.loop = describeLoop(loop)
    if (loop.verdict) loopVerdicts[host.planned.unit.id] = loop.verdict
    try {
      // An interrupted loop retries its chain, even when its host's report is still in `out/`.
      if (loop.interrupted)
        host.outcome = { kind: 'none', reason: 'interrupted', unpublished: true }
      else {
        await appendLoopSummary(dir, loop)
        const published = await publish({ ...unit, deliver: 'draft_pr' }, dir, n.forge, n.runId)
        // A report host whose loop committed nothing keeps its report, if the loop ran to its end.
        const kept =
          host.outcome?.kind === 'report' && published.kind === 'none' && !published.unpublished
        if (!kept) host.outcome = published
        else if (!loop.completed)
          host.outcome = { kind: 'none', reason: `loop ${loop.ended}`, unpublished: true }
        if (published.kind === 'pr') {
          opened[`${unit.repo} ${unit.branch}`] = published.url
          if (loop.stacks) tips[unit.repo] = unit.branch
        }
      }
    } catch (e) {
      Object.assign(host, { status: 'error', reason: (e as Error).message, outcome: undefined })
    } finally {
      const out = join(WORK_DIR, 'out')
      await cp(join(dir, out), join(loop.unitDir, 'out'), {
        recursive: true,
        filter: notSymlink,
      }).catch(() => {})
      await rm(dir, { recursive: true, force: true })
    }
    n.ctx.log(`${unit.id}: loop ${host.loop}`)
  }

  for (const p of planned) {
    if (open && p.loop?.host !== open.unit.id) await closeLoop(open)
    const inRound = !!p.loop && p.loop.host !== p.unit.id
    const round = inRound ? open : undefined
    if (p.loop && inRound && (!round || round.ended)) {
      if (!round && p.loop.round === 1 && p.loop.step === 0) {
        const host = results.find((r) => r.planned.unit.id === p.loop?.host)
        results.push({
          planned: p,
          status: 'skipped',
          reason: n.dryRun
            ? 'a dry run delivers nothing for it to follow'
            : host?.status === 'done'
              ? `${p.loop.host} left nothing to loop on`
              : `${p.loop.host} ${host?.status ?? 'did not run'}, loop not started`,
        })
      }
      continue
    }
    const hosting = hosts.has(p.unit.id)
    const standIn = p.after ? standIns[p.after] : undefined
    const after = standIn?.result ?? results.find((r) => p.after && r.planned.unit.id === p.after)
    const base =
      standIn?.base ??
      (after && after.outcome?.kind !== 'pr'
        ? (ranOn[after.planned.unit.id] ?? p.unit.base)
        : p.unit.base)
    const planUnit = { ...p.unit, base }
    const { repo } = planUnit
    // A loop publishes its host as a draft PR, whatever the host's own delivery.
    const deliver = hosting ? 'draft_pr' : p.unit.deliver
    const stacks = !round && deliver === 'draft_pr' && (base === '' || base === tips[repo])
    const onto = stacks ? (tips[repo] ?? '') : base
    const tonight = opened[`${repo} ${onto}`]
    const stackedOn = deliver === 'draft_pr' ? tonight : undefined
    const unit = round
      ? { ...p.unit, base: round.unit.base, stackedOn: round.unit.stackedOn }
      : stackedOn
        ? { ...planUnit, base: onto, stackedOn }
        : planUnit
    ranOn[p.unit.id] = unit.base
    starts[unit.id] = round
      ? (starts[round.unit.id] ?? '')
      : stacks && !openedPr(after)
        ? onto
        : ((after && starts[after.planned.unit.id]) ?? '')
    const skip = (reason: string) => {
      results.push({ planned: p, status: 'skipped', reason })
      if (round) round.ended = reason
    }
    if (n.signal?.aborted) {
      skip('interrupted')
      if (round) round.interrupted = true
      continue
    }
    if (n.until && new Date() >= n.until) {
      skip('the night window ended')
      continue
    }
    if (p.after && (after?.outcome?.kind ?? 'none') === 'none') {
      skip(
        n.dryRun
          ? 'a dry run delivers nothing for it to follow'
          : `${p.after} delivered nothing to follow`,
      )
      continue
    }
    const { provider: id, passed } = route(unit.providers, allowances, routed)
    const provider = id && n.providers[id]
    if (!id || !provider) {
      skip(`no provider left: ${passed.join('; ') || 'none configured'}`)
      continue
    }
    if (!round && deliver === 'draft_pr' && (await n.forge.branchExists(unit.repo, unit.branch))) {
      skip(`${unit.branch} already exists on ${unit.repo}`)
      continue
    }
    routed[id] = (routed[id] ?? 0) + 1
    const entry = n.config.providers.find((c) => c.id === id)
    const model = unit.rule.model?.[id] ?? entry?.model
    n.ctx.log(`${unit.id}: ${unit.skill} on ${id}${model ? ` (${model})` : ''}`)

    const unitDir = join(n.runDir, 'units', unit.id)
    const dir = round?.dir ?? join(n.runDir, 'work', unit.id)
    const plugin = join(n.runDir, 'plugins', unit.id)
    await mkdir(unitDir, { recursive: true })
    const logFile = createWriteStream(join(unitDir, 'worker.log'))
    const log = (line: string) => logFile.write(`${new Date().toISOString()} ${line}\n`)
    const result: UnitResult = { planned: p, provider: id, status: 'prepared' }
    results.push(result)
    let start: string | undefined
    try {
      const ctx = { ...n.ctx, log }
      const before = round?.last ?? after
      // A loop's host has no outcome until the loop publishes it.
      const previous =
        before && (round || before.outcome)
          ? {
              skill: before.planned.unit.skill,
              outcome: before.outcome,
              out: join(n.runDir, 'units', before.planned.unit.id, 'out'),
            }
          : undefined
      const prompt = await prepareWorkspace({
        ...n,
        unit,
        dir,
        plugin,
        provider,
        ctx,
        previous,
        reuse: !!round,
        loop: p.loop,
      })
      if (n.dryRun) continue
      const a = allowances[id]
      if (!a) continue
      const repo = n.config.repos[unit.repo]
      if (repo?.setup && !unit.untrusted && !round) {
        // A PR someone else opened, or a branch a worker wrote tonight, runs install scripts you didn't write: they get none of the repo's secrets.
        const own = unit.foreign || tonight ? [] : repo.secrets
        const failed = await runSetup(
          repo.setup,
          dir,
          setupEnv(n.ctx.env, dir, secrets, own),
          log,
          {
            secrets: own,
            signal: n.signal,
            until: n.until,
          },
        )
        if (failed) {
          Object.assign(result, { status: 'skipped', reason: failed })
          continue
        }
      }
      if (!round) baselines.set(dir, new Set(await uncommitted(dir)))
      const { when } = unit.rule
      if (when) {
        const logFile = join(dir, WORK_DIR, 'context', 'previous', 'when.log')
        const verdict = (before && loopVerdicts[before.planned.unit.id]) ?? before?.verdict
        const met = await factsFor(when, unit, dir, verdict, log, logFile)
        // A check stopped before it exited says nothing: skip the step without passing over it.
        if (met.check?.stopped && !met.check.refused) {
          const reason = `when ${describeCondition(when)} not checked: ${met.check.failed}`
          Object.assign(result, { status: 'skipped', reason })
          routed[id] = (routed[id] ?? 1) - 1
          if (round) Object.assign(round, { ended: reason, interrupted: n.signal?.aborted })
          continue
        }
        if (!holds(when, met.facts)) {
          const failed = met.check?.failed ? ` (${met.check.failed})` : ''
          const reason = `when ${describeCondition(when)} didn't hold${failed}`
          Object.assign(result, { status: 'skipped', reason, passedOver: true })
          routed[id] = (routed[id] ?? 1) - 1
          if (round && p.loop && isLast(p.loop)) round.ended = maxReached(p.loop.max)
          if (!inRound && after) standIns[unit.id] = { result: after, base: unit.base }
          continue
        }
      }
      const maxTurns = a.kind === 'fallback' ? a.turns : MAX_TURNS
      const withheld = secrets.filter((name) => !provider.secrets.includes(name))
      const env = workerEnv(n.ctx.env, dir, withheld)
      const config = entry?.config
      const job = {
        unit,
        dir,
        prompt,
        maxTurns,
        model,
        env,
        config,
        configDir: n.configDir,
        plugin,
      }
      start = await head(dir)
      const worker = await runWorker(provider, job, a, {
        log,
        signal: n.signal,
        until: n.until,
        maxMinutes: entry?.budget.unit_minutes,
        watch: n.watch,
      })
      Object.assign(result, worker)
      if (worker.quota) {
        quotas[id] = worker.quota
        allowances[id] = withQuota(a, worker.quota)
      }
      result.verdict = await readVerdict(dir)
      const aborted = worker.status === 'stopped: aborted'
      if (p.loop) {
        result.outcome = await roundOutcome(unit, dir, start)
        const logFile = join(dir, WORK_DIR, 'out', 'check.log')
        const verdict = result.verdict ?? round?.verdict
        const until =
          worker.status === 'done'
            ? await factsFor(p.loop.until, unit, dir, verdict, log, logFile)
            : undefined
        const loop = round ?? {
          host: result,
          unit,
          dir,
          unitDir,
          stacks,
          skills: p.loop.skills,
          rounds: 0,
        }
        open = loop
        loop.rounds = p.loop.round
        loop.last = result
        if (result.verdict) loop.verdict = result.verdict
        if (result.outcome.kind === 'report')
          loop.report = { id: unit.id, text: result.outcome.text }
        if (until?.check) loop.check = until.check
        if (aborted || n.signal?.aborted)
          Object.assign(loop, { ended: 'interrupted', interrupted: true })
        else if (!until) loop.ended = `${unit.id} ${worker.status}`
        else if (until.check?.stopped)
          loop.ended = `until ${describeCondition(p.loop.until)} not checked: ${until.check.failed}`
        else if (untilHolds(p.loop.until, until.facts))
          Object.assign(loop, {
            ended: `until held: ${describeCondition(p.loop.until)}`,
            completed: true,
          })
        else if (isLast(p.loop))
          Object.assign(loop, { ended: maxReached(p.loop.max), completed: true })
      } else if (hosting && worker.status === 'done' && (await commitsSince(dir, start)) > 0) {
        const skills = planned.find((u) => u.loop?.host === unit.id)?.loop?.skills ?? []
        open = { host: result, unit, dir, unitDir, stacks, skills, rounds: 0, last: result }
      } else if (!aborted) {
        result.outcome = await publish(unit, dir, n.forge, n.runId)
        if (result.outcome?.kind === 'pr') {
          opened[`${unit.repo} ${unit.branch}`] = result.outcome.url
          if (stacks) tips[unit.repo] = unit.branch
        }
      }
    } catch (e) {
      Object.assign(result, { status: 'error', reason: (e as Error).message })
      log(`error: ${(e as Error).stack}`)
      if (open?.dir === dir) open.ended = `${unit.id} error`
    } finally {
      await new Promise((done) => logFile.end(done))
      await cp(join(dir, WORK_DIR), unitDir, {
        recursive: true,
        filter: async (src) => src !== join(dir, WORK_DIR, 'gh') && (await notSymlink(src)),
      }).catch(() => {})
      const kept = open?.dir === dir
      if (kept && start)
        await handOff(dir, start, unitDir).catch((e) => {
          if (open)
            Object.assign(open, {
              ended: `${unit.id} error: ${(e as Error).message}`,
              completed: false,
            })
        })
      if (!n.dryRun)
        await Promise.all(
          (kept ? [plugin] : [dir, plugin]).map((d) => rm(d, { recursive: true, force: true })),
        )
    }
    n.ctx.log(`${unit.id}: ${result.status}`)
  }
  if (open) await closeLoop(open)

  const { runId, dryRun, plan } = n
  return { runId, dryRun, startedAt, finishedAt: new Date(), plan, results, quotas }
}

/** A loop's clone, kept open for its rounds until it publishes. */
interface OpenLoop {
  /** The unit whose clone and branch the loop works on; the loop's draft PR is its outcome. */
  host: UnitResult
  unit: Unit
  dir: string
  unitDir: string
  stacks: boolean
  skills: string[]
  rounds: number
  /** The unit the next round follows. */
  last?: UnitResult
  verdict?: string
  report?: { id: string; text: string }
  /** The last run of `until`'s command. */
  check?: RanCheck
  ended?: string
  /** It ended at `until` or `max`, not on a failure, a skip or an interrupt. */
  completed?: boolean
  interrupted?: boolean
}

interface Check {
  output: string
  failed?: string
  /** Refused, or stopped before it exited: the condition is unknown, not false. */
  stopped?: true
  /** Never runs on this unit, so a `when` on it can't hold. */
  refused?: true
}

type RanCheck = Check & { command: string }

const refusal = (failed: string): Check => ({ output: '', failed, stopped: true, refused: true })

const git = async (dir: string, ...args: string[]) =>
  (await execa('git', ['-C', dir, ...args])).stdout

const head = (dir: string) => git(dir, 'rev-parse', 'HEAD')

/** `git status --porcelain` lines, one per uncommitted path. */
async function uncommitted(dir: string): Promise<string[]> {
  return (await git(dir, 'status', '--porcelain')).split('\n').filter(Boolean)
}

async function commitsSince(dir: string, start: string): Promise<number> {
  return Number(await git(dir, 'rev-list', '--count', `${start}..HEAD`))
}

/** `until` waits for a verdict written inside the loop, even one it only wants `{ not }` of. */
function untilHolds(until: Condition, facts: Facts): boolean {
  return (until.verdict === undefined || facts.verdict !== undefined) && holds(until, facts)
}

/** Whether the chain's commits since `start`, the default branch when empty, touch `globs`. */
async function changes(dir: string, globs: string[], start = ''): Promise<boolean> {
  const paths = globs.map((glob) => `:(glob)${glob}`)
  const since = `origin/${start || 'HEAD'}...HEAD`
  return (await git(dir, 'diff', '--name-only', since, '--', ...paths)) !== ''
}

/** The command and the tail of its output, for the step after it. */
function checkLog({ command, output, failed }: RanCheck): string {
  const tail = output.slice(-CHECK_LOG_CHARS)
  return `$ ${command}\n${tail}\n${failed ? `failed: ${failed}` : 'passed'}\n`
}

function isLast(loop: { round: number; max: number; step: number; skills: string[] }): boolean {
  return loop.round === loop.max && loop.step === loop.skills.length - 1
}

function maxReached(max: number): string {
  return `max ${max} ${max === 1 ? 'round' : 'rounds'} reached`
}

/** The one lowercase word a skill wrote to `out/verdict`, if any. */
async function readVerdict(dir: string): Promise<string | undefined> {
  const text = await readOutput(join(dir, WORK_DIR, 'out', 'verdict'))
  const word = text.trim().toLowerCase()
  return /^[a-z][a-z_-]*$/.test(word) ? word : undefined
}

/** A round's report, or the commits it left for the loop's draft PR. */
async function roundOutcome(unit: Unit, dir: string, start: string): Promise<Outcome> {
  if (unit.deliver === 'report') {
    const file = join(dir, WORK_DIR, 'out', 'report.md')
    const text = (await readOutput(file)).trim()
    return text ? { kind: 'report', text } : { kind: 'none', reason: 'no report written' }
  }
  const commits = await commitsSince(dir, start)
  return {
    kind: 'none',
    reason: commits > 0 ? `${commits} commits for the loop's PR` : 'no commits',
  }
}

/** Saves a unit's own commits for the next round, and clears what only it wrote from the shared clone. */
async function handOff(dir: string, start: string, unitDir: string): Promise<void> {
  const diff = await git(dir, 'diff', '--no-ext-diff', '--no-textconv', start, 'HEAD')
  // A round that cleaned the clone left no `out/` to copy.
  await mkdir(join(unitDir, 'out'), { recursive: true })
  if (diff) await writeFile(join(unitDir, 'out', 'diff.patch'), `${diff}\n`)
  await refuseSymlinks(dir, [`${WORK_DIR}/out`])
  const out = join(dir, WORK_DIR, 'out')
  await Promise.all(
    ['report.md', 'verdict', 'check.log'].map((f) => rm(join(out, f), { force: true })),
  )
}

/** E.g. `2 rounds of review ⇄ address-review; until held: verdict approve`. */
function describeLoop(loop: OpenLoop): string {
  const rounds = `${loop.rounds} ${loop.rounds === 1 ? 'round' : 'rounds'}`
  return `${rounds} of ${loop.skills.join(' ⇄ ')}; ${loop.ended ?? 'nothing ran'}`
}

/** night-shift's own note in the PR body: how the loop went, its last verdict, and the last report a round wrote. */
async function appendLoopSummary(dir: string, loop: OpenLoop): Promise<void> {
  await refuseSymlinks(dir, [`${WORK_DIR}/out/pr.md`])
  const file = join(dir, WORK_DIR, 'out', 'pr.md')
  const body = (await readOutput(file)).trim()
  if (!body || loop.rounds === 0) return
  const verdict = loop.verdict ? `; last verdict ${loop.verdict}` : ''
  const lines = ['', '', '## Night-shift loop', '', `${describeLoop(loop)}${verdict}.`]
  const { report, check } = loop
  if (report)
    lines.push(
      '',
      `<details><summary>Last report: ${report.id}</summary>`,
      '',
      report.text,
      '',
      '</details>',
    )
  if (check?.failed) {
    const log = checkLog(check).trim()
    const fence = '`'.repeat(Math.max(3, ...[...log.matchAll(/`+/g)].map((m) => m[0].length + 1)))
    lines.push(
      '',
      `<details><summary>Last check: \`${check.command}\` failed</summary>`,
      '',
      fence,
      log,
      fence,
      '',
      '</details>',
    )
  }
  await writeOutput(file, `${body}${lines.join('\n')}\n`)
}

/** Like the worker's, with every secret withheld except the repo's own. */
function setupEnv(
  env: NodeJS.ProcessEnv,
  dir: string,
  secrets: string[],
  own: string[],
): NodeJS.ProcessEnv {
  const passed = own.filter((name) => env[name] !== undefined).map((name) => [name, env[name]])
  return { ...workerEnv(env, dir, secrets), ...Object.fromEntries(passed) }
}
