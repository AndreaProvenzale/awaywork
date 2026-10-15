import { createWriteStream, existsSync } from 'node:fs'
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join, relative } from 'node:path'
import { execa } from 'execa'
import { bin } from '../config/paths.js'
import type { Config } from '../config/schema.js'
import { MAX_TURNS, quotaFacts, route, withQuota } from '../core/budget.js'
import { describeCondition, type Facts, holds } from '../core/condition.js'
import { footerItems, hasTrailer } from '../core/footer.js'
import { describeChain, type PlannedUnit, type RunPlan, slug } from '../core/foreman.js'
import type { RunReport, UnitResult } from '../core/report.js'
import type {
  Condition,
  Ctx,
  Forge,
  McpServer,
  Provider,
  Quota,
  Source,
  Unit,
} from '../core/types.js'
import { afterUnit } from './notify.js'
import { type Outcome, publish } from './publish.js'
import type { ReplayState } from './replay.js'
import { runWorker, type WorkerOptions } from './run.js'
import { maskSecrets, runCommand, runSetup } from './setup.js'
import {
  commandEnv,
  configSecrets,
  notSymlink,
  outputFile,
  prepareWorkspace,
  readOutput,
  refuseSymlinks,
  restoreGitConfig,
  WORK_DIR,
  workerEnv,
  writeOutput,
} from './workspace.js'

const CHECK_LOG_CHARS = 8000
const MAX_SUFFIX = 10

export interface RunInput {
  config: Config
  configDir: string
  plan: RunPlan
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

/** The units `name` names, by unit id or item key in any case. */
export function namedUnits(plan: RunPlan, name: string): Set<string> {
  const only = slug(name)
  return new Set(
    plan.units
      .filter((p) => p.unit.id === only || p.unit.items.some((i) => slug(i.key) === only))
      .map((p) => p.unit.id),
  )
}

/**
 * Runs the plan's chains one at a time, re-routing as windows fill. A rule's steps all work in one
 * clone, and the chain publishes once at the end: its commits as a draft PR or a push onto your PR,
 * else its reports. A draft PR stacks on the awaywork PR a rule took up.
 * Every step leaves `units/<id>/<n>-<skill>/` in the run dir: its context, prompt, output and worker
 * log; what the chain published is in `units/<id>/out/`.
 */
export async function runUnits(input: RunInput): Promise<RunReport> {
  const startedAt = new Date()
  const allowances = { ...input.plan.allowances }
  const routed: Record<string, number> = {}
  const quotas: Record<string, Quota> = {}
  const results: UnitResult[] = []
  const wanted = input.only ? namedUnits(input.plan, input.only) : new Set<string>()
  if (input.only && wanted.size === 0) throw new Error(`no unit "${input.only}" in this run's plan`)
  // A step needs its whole chain.
  const heads = new Set(
    [...wanted].map((id) => input.plan.units.find((p) => p.unit.id === id)?.chain ?? id),
  )
  const chains = input.plan.units
    .filter((p) => !p.chain && (!input.only || heads.has(p.unit.id)))
    .map((head) => [head, ...input.plan.units.filter((p) => p.chain === head.unit.id)])
  const secrets = configSecrets(input.config, input.providers, input.sources)

  const checks = new Map<string, Check>()
  // What each clone had uncommitted before a worker could leave anything: setup's and the checks' leftovers.
  const baselines = new Map<string, Set<string>>()
  // Each clone's git config as cloned, put back after anything ran the worker's code in it.
  const gitConfigs = new Map<string, string>()
  const restoreGit = (dir: string) => restoreGitConfig(dir, gitConfigs.get(dir) ?? '')

  /**
   * Runs a condition's command in the clone outside the model, once per commit, with none of the
   * secrets. When it decides what is published (`until`), files left uncommitted fail it.
   */
  const check = async (
    command: string,
    unit: Unit,
    dir: string,
    log: (line: string) => void,
    published: boolean,
  ): Promise<Check> => {
    if (unit.untrusted) return refusal("not run on an untrusted author's PR")
    // The worker's sandbox is the provider's: awaywork has none to run worker-written code in.
    if (!unit.network) return refusal('not run without network: it has no sandbox')
    const before = await uncommitted(dir)
    const baseline = baselines.get(dir) ?? new Set()
    const left = before.filter((line) => !baseline.has(line))
    if (left.length && published)
      return { output: left.join('\n'), failed: 'uncommitted changes in the clone' }
    const key = `${dir} ${await head(dir)} ${command}`
    const known = left.length ? undefined : checks.get(key)
    if (known) return known
    const result = await runCommand(command, dir, workerEnv(input.ctx.env, dir, secrets), {
      secrets: [],
      signal: input.signal,
      until: input.until,
    })
    log(`check ${command}: ${result.failed ?? 'passed'}${result.output && `\n${result.output}`}`)
    await restoreGit(dir)
    // Only what the check itself left joins the baseline, never what a worker left before it.
    for (const line of await uncommitted(dir)) if (!before.includes(line)) baseline.add(line)
    baselines.set(dir, baseline)
    if (!result.stopped && !left.length) checks.set(key, result)
    return result
  }

  /** What `condition` needs to know about the clone; a command's output goes to `logFile`. */
  const factsFor = async (
    condition: Condition,
    unit: Unit,
    dir: string,
    since: string,
    verdict: string | undefined,
    log: (line: string) => void,
    logFile: string,
    published = false,
  ) => {
    const facts: Facts = { verdict }
    let ran: RanCheck | undefined
    if (condition.command) {
      const result = await check(condition.command, unit, dir, log, published)
      ran = { command: condition.command, ...result }
      facts.command = !ran.failed
      await refuseSymlinks(dir, [relative(dir, logFile)])
      await mkdir(dirname(logFile), { recursive: true })
      await writeOutput(logFile, checkLog(ran))
    }
    if (condition.changed) facts.changed = await changes(dir, condition.changed, since)
    return { facts, check: ran }
  }

  /** Runs after_unit for each step of a finished chain: its own output, and the chain's PR. Once interrupted, none starts. */
  const afterUnits = async (chain: UnitResult[]) => {
    const hook = input.config.after_unit
    if (!hook || input.dryRun) return
    const outcome = chain[0]?.outcome
    const pr = outcome?.kind === 'pr' ? outcome.url : undefined
    for (const r of chain) {
      if (input.signal?.aborted) return
      const { id, skill, deliver } = r.planned.unit
      const chainId = r.planned.chain ?? id
      const out = r.step && join(input.runDir, 'units', chainId, r.step, 'out', outputFile[deliver])
      const failure = await afterUnit(
        hook.command,
        {
          runId: input.runId,
          id,
          skill,
          status: r.status,
          pr,
          report: out && existsSync(out) ? out : undefined,
        },
        input.signal,
      )
      if (failure)
        input.ctx.log(
          `after_unit failed for ${id}: ${maskSecrets(failure, secrets, input.ctx.env)}`,
        )
    }
  }

  const runChain = async (chain: PlannedUnit[]): Promise<UnitResult[]> => {
    const done: UnitResult[] = []
    const first = chain[0] as PlannedUnit
    const { repo, base } = first.unit
    const deliver = chain.find((p) => p.unit.deliver !== 'report')?.unit.deliver ?? 'report'
    // An awaywork PR a rule took up, when the chain works on its branch.
    const pickedUp = first.unit.items
      .flatMap((i) => i.linkedPrs)
      .find((pr) => pr.ours && pr.repo === repo && pr.branch === base)
    const shape = {
      branch: first.unit.branch,
      stackedOn: deliver === 'draft_pr' ? pickedUp?.url : undefined,
    }
    // `changed` diffs from where the chain started: the awaywork PR it took up, else the default branch.
    const since = pickedUp ? base : ''
    const dir = join(input.runDir, 'work', first.unit.id)
    const chainDir = join(input.runDir, 'units', first.unit.id)
    const steps = chain.length > 1 ? describeChain(chain) : undefined
    const loops: Record<number, OpenLoop> = {}
    const reports: StepReport[] = []
    let cloned: string | undefined
    let previous: { skill: string; out: string } | undefined
    let verdict: string | undefined
    let ran = false
    let interrupted = false
    // Why the steps left didn't run, and whether they're passed over rather than missed.
    let ended: { reason: string; passedOver?: true } | undefined

    for (const p of chain) {
      if (p.loop) loops[p.loop.at] ??= { skills: p.loop.skills, rounds: 0 }
      const loop = p.loop && loops[p.loop.at]
      // A loop's later rounds run only while it goes on: once the chain ended, or in a dry run, only its first is listed.
      if (loop?.ended || ((ended || input.dryRun) && p.loop && p.loop.round > 1)) continue
      const skip = (reason: string, passedOver?: true) =>
        done.push({ planned: p, status: 'skipped', reason, ...(passedOver && { passedOver }) })
      const end = (reason: string) => {
        skip(reason)
        ended = { reason }
        if (loop) loop.ended ??= reason
      }
      if (ended) {
        skip(ended.reason, ended.passedOver)
        continue
      }
      if (input.signal?.aborted) {
        interrupted = true
        end('interrupted')
        continue
      }
      if (input.until && new Date() >= input.until) {
        end('the window ended')
        continue
      }
      const unit = { ...p.unit, ...shape }
      const { provider: id, passed } = route(unit.providers, allowances, routed)
      const provider = id && input.providers[id]
      if (!id || !provider) {
        end(`no provider left: ${passed.join('; ') || 'none configured'}`)
        continue
      }
      if (cloned === undefined && deliver === 'draft_pr') {
        const free = await freeBranch(input.forge, unit).catch((e: Error) => ({
          skip: `couldn't check ${unit.branch} on ${unit.repo}: ${e.message}`,
        }))
        if ('skip' in free) {
          end(free.skip)
          continue
        }
        if (free.branch !== unit.branch)
          input.ctx.log(`${unit.id}: ${unit.branch} is taken on ${unit.repo}, using ${free.branch}`)
        shape.branch = unit.branch = free.branch
      }
      routed[id] = (routed[id] ?? 0) + 1
      const entry = input.config.providers.find((c) => c.id === id)
      const model = unit.rule.model?.[id] ?? entry?.model
      input.ctx.log(`${unit.id}: ${unit.skill} on ${id}${model ? ` (${model})` : ''}`)

      const step = `${done.filter((r) => r.step).length + 1}-${slug(unit.skill)}`
      const unitDir = join(chainDir, step)
      const plugin = join(input.runDir, 'plugins', unit.id)
      await mkdir(unitDir, { recursive: true })
      const logFile = createWriteStream(join(unitDir, 'worker.log'))
      const log = (line: string) => logFile.write(`${new Date().toISOString()} ${line}\n`)
      const result: UnitResult = {
        planned: { ...p, unit: { ...p.unit, branch: unit.branch } },
        provider: id,
        status: 'prepared',
        step,
      }
      done.push(result)
      let start: string | undefined
      try {
        const ctx = { ...input.ctx, log }
        const reuse = cloned !== undefined
        const prompt = await prepareWorkspace({
          ...input,
          unit,
          dir,
          plugin,
          provider,
          ctx,
          previous,
          reuse,
          chain: steps,
          loop: p.loop,
        })
        if (!reuse) {
          // Before setup or any worker touched the clone: the chain's commits are the ones after it.
          cloned = await head(dir)
          gitConfigs.set(dir, await readFile(join(dir, '.git', 'config'), 'utf8'))
          const state: ReplayState = { unit, provider: id, commit: cloned }
          await writeFile(join(unitDir, 'replay.json'), `${JSON.stringify(state, null, 2)}\n`)
        }
        if (input.dryRun) continue
        const a = allowances[id]
        if (!a) continue
        const settings = input.config.repos[unit.repo]
        if (!reuse && settings?.setup && !unit.untrusted) {
          // A PR someone else opened, or an awaywork PR's branch a worker wrote, runs install scripts you didn't write: they get none of the repo's secrets.
          const own = unit.foreign || pickedUp ? [] : settings.secrets
          const failed = await runSetup(
            settings.setup,
            dir,
            setupEnv(input.ctx.env, dir, secrets, own),
            log,
            { secrets: own, signal: input.signal, until: input.until },
          )
          if (failed) {
            Object.assign(result, { status: 'skipped', reason: failed })
            ended = { reason: `${unit.id} setup failed` }
            continue
          }
          await restoreGit(dir)
        }
        if (!reuse) baselines.set(dir, new Set(await uncommitted(dir)))
        const { when } = unit.rule
        if (when) {
          const logFile = join(dir, WORK_DIR, 'context', 'previous', 'when.log')
          const met = await factsFor(when, unit, dir, since, verdict, log, logFile)
          Object.assign(met.facts, quotaFacts(a))
          // A check stopped or timed out before it exited says nothing: the chain ends without passing over it.
          if (met.check?.stopped || met.check?.timedOut) {
            const reason = `when ${describeCondition(when)} not checked: ${met.check.failed}`
            Object.assign(result, { status: 'skipped', reason })
            routed[id] = (routed[id] ?? 1) - 1
            ended = { reason }
            interrupted ||= !!input.signal?.aborted
            continue
          }
          if (!holds(when, met.facts)) {
            const failed = met.check?.failed ? ` (${met.check.failed})` : ''
            const reason = `when ${describeCondition(when)} didn't hold${failed}`
            Object.assign(result, { status: 'skipped', reason, passedOver: true })
            routed[id] = (routed[id] ?? 1) - 1
            // A rule's own `when` gates its whole chain.
            if (p === first) ended = { reason, passedOver: true }
            // A refused check is refused every round: the loop would repeat without its step.
            else if (loop && p.loop && met.check?.refused) loop.ended = reason
            else if (loop && p.loop && p.loop.step === p.loop.skills.length - 1) {
              // A round where no step ran left nothing: the next one would pass over the same.
              const idle = loop.rounds < p.loop.round
              if (idle) loop.ended = "no step's when held"
              else if (isLast(p.loop)) loop.ended = maxReached(p.loop.max)
            }
            continue
          }
        }
        const maxTurns = a.kind === 'fallback' ? a.turns : MAX_TURNS
        const named = unit.rule.mcp ?? []
        if (named.length > 0 && unit.foreign)
          log(`mcp: ${named.join(', ')} not started on someone else's PR`)
        const mcp: Record<string, McpServer> = {}
        for (const name of unit.foreign ? [] : named) {
          const server = input.config.mcp[name] as McpServer
          const unset = server.secrets.filter((secret) => !input.ctx.env[secret])
          if (unset.length > 0) log(`mcp: ${name} not started, unset: ${unset.join(', ')}`)
          else mcp[name] = server
        }
        const given = [...provider.secrets, ...Object.values(mcp).flatMap((s) => s.secrets)]
        const withheld = secrets.filter((name) => !given.includes(name))
        const env = workerEnv(input.ctx.env, dir, withheld)
        const config = entry?.config
        const job = {
          unit,
          dir,
          prompt,
          maxTurns,
          model,
          env,
          config,
          configDir: input.configDir,
          plugin,
          mcp,
        }
        if (a.kind === 'quota')
          result.baseline = { name: a.window, used: a.used, resetsAt: a.resetsAt }
        start = await head(dir)
        ran = true
        const worker = await runWorker(provider, job, a, {
          log,
          signal: input.signal,
          until: input.until,
          maxMinutes: input.config.limits.unit_minutes,
          watch: input.watch,
        })
        await restoreGit(dir)
        Object.assign(result, worker)
        if (loop && p.loop) loop.rounds = p.loop.round
        if (worker.quota) {
          quotas[id] = worker.quota
          allowances[id] = withQuota(a, worker.quota)
        }
        result.verdict = await readVerdict(dir)
        verdict = result.verdict ?? verdict
        const commits = await commitsSince(dir, start)
        const report = (await readOutput(join(dir, WORK_DIR, 'out', outputFile.report))).trim()
        if (report) reports.push({ id: unit.id, skill: unit.skill, text: report })
        result.made = made(commits, report)
        // What the next step works from: a committing step's commits, a report step's report.
        const left = unit.deliver === 'report' ? report !== '' : commits > 0
        if (worker.status === 'stopped: aborted' || input.signal?.aborted) {
          interrupted = true
          ended = { reason: 'interrupted' }
        } else if (worker.status !== 'done') ended = { reason: `${unit.id} ${worker.status}` }
        else if (!left) {
          const reason = `${unit.id} ${unit.deliver === 'report' ? 'wrote no report' : 'committed nothing'}`
          // Inside a loop it ends only the loop: the steps after it still run.
          if (loop) loop.ended = reason
          else ended = { reason, passedOver: true }
        } else if (loop && p.loop) {
          if (result.verdict) loop.verdict = result.verdict
          const logFile = join(dir, WORK_DIR, 'out', 'check.log')
          const until = await factsFor(
            p.loop.until,
            unit,
            dir,
            since,
            loop.verdict,
            log,
            logFile,
            true,
          )
          if (until.check) loop.check = until.check
          if (until.check?.stopped || until.check?.refused)
            loop.ended = `until ${describeCondition(p.loop.until)} not checked: ${until.check.failed}`
          else if (untilHolds(p.loop.until, until.facts))
            loop.ended = `until held: ${describeCondition(p.loop.until)}`
          else if (isLast(p.loop)) loop.ended = maxReached(p.loop.max)
        }
        if (loop && ended) loop.ended ??= ended.reason
      } catch (e) {
        Object.assign(result, { status: 'error', reason: (e as Error).message })
        log(`error: ${(e as Error).stack}`)
        ended = { reason: `${unit.id} error: ${(e as Error).message}` }
        if (loop) loop.ended ??= ended.reason
      } finally {
        await new Promise((done) => logFile.end(done))
        await cp(join(dir, WORK_DIR), unitDir, {
          recursive: true,
          filter: async (src) => src !== join(dir, WORK_DIR, 'gh') && (await notSymlink(src)),
        }).catch(() => {})
        if (start)
          try {
            await restoreGit(dir)
            await handOff(dir, start, unitDir)
            previous = { skill: unit.skill, out: join(unitDir, 'out') }
          } catch (e) {
            ended ??= { reason: `${unit.id} error: ${(e as Error).message}` }
            if (loop) loop.ended ??= ended.reason
          }
        if (!input.dryRun) await rm(plugin, { recursive: true, force: true })
      }
      input.ctx.log(`${unit.id}: ${result.status}`)
    }

    const host = done.find((r) => r.planned.unit.id === first.unit.id && r.status !== 'skipped')
    if (cloned !== undefined && host && ran && !input.dryRun) {
      if (Object.keys(loops).length) host.loop = Object.values(loops).map(describeLoop).join('; ')
      try {
        host.outcome = interrupted
          ? { kind: 'none', reason: 'interrupted', unpublished: true }
          : await publishChain(first.unit, deliver, shape, dir, cloned, reports, loops)
      } catch (e) {
        // The steps ran as they did: only the publish failed.
        host.outcome = { kind: 'none', reason: (e as Error).message, unpublished: true }
      } finally {
        await cp(join(dir, WORK_DIR, 'out'), join(chainDir, 'out'), {
          recursive: true,
          filter: notSymlink,
        }).catch(() => {})
      }
    }
    if (!input.dryRun) await rm(dir, { recursive: true, force: true })
    return done
  }

  /** Publishes the chain's commits as one draft PR or push, with its reports; without commits, its reports. */
  const publishChain = async (
    unit: Unit,
    deliver: Unit['deliver'],
    shape: Pick<Unit, 'branch' | 'stackedOn'>,
    dir: string,
    cloned: string,
    reports: StepReport[],
    loops: Record<number, OpenLoop>,
  ): Promise<Outcome> => {
    const out = join(dir, WORK_DIR, 'out')
    if (deliver === 'report' || (await commitsSince(dir, cloned)) === 0) {
      const text = reports.length === 1 ? (reports[0]?.text ?? '') : joinReports(reports)
      if (!text)
        return { kind: 'none', reason: deliver === 'report' ? 'no report written' : 'no commits' }
      await refuseSymlinks(dir, [`${WORK_DIR}/out/${outputFile.report}`])
      await writeOutput(join(out, outputFile.report), `${text}\n`)
      return { kind: 'report', text }
    }
    const publishing = { ...unit, ...shape, deliver }
    await refuseSymlinks(dir, [`${WORK_DIR}/out/${outputFile[deliver]}`])
    await appendChainNotes(join(out, outputFile[deliver]), reports, Object.values(loops))
    await verify(publishing, dir, cloned)
    if (input.signal?.aborted) return { kind: 'none', reason: 'interrupted', unpublished: true }
    return publish(publishing, dir, input.forge, input.runId, cloned)
  }

  /** Runs the unit's `verify` before it is published; a failure goes in the PR body, and the unit is still published. */
  const verify = async (unit: Unit, dir: string, start: string) => {
    if (!unit.verify || (await commitsSince(dir, start)) === 0) return
    const result = await check(unit.verify, unit, dir, input.ctx.log, false)
    if (!result.failed) return
    await appendVerifyFailure(join(dir, WORK_DIR, 'out', outputFile[unit.deliver]), {
      command: unit.verify,
      ...result,
    })
  }

  for (const chain of chains) {
    const done = await runChain(chain)
    results.push(...done)
    await afterUnits(done)
  }

  const { runId, dryRun, plan } = input
  return { runId, dryRun, startedAt, finishedAt: new Date(), plan, results, quotas }
}

/**
 * The unit's planned branch, else the first of `<branch>-2` to `-10` not on the remote. A taken name
 * whose PR, open or closed unmerged, awaywork opened for one of the unit's items means it tried
 * already (a merged one landed, so the next pickup is a new round and takes a suffix), and
 * one with no PR whose tip has awaywork's trailer is a push whose PR failed: either way the unit
 * is skipped until that branch is deleted, even where no attempts are kept.
 */
async function freeBranch(
  forge: Forge,
  unit: Unit,
): Promise<{ branch: string } | { skip: string }> {
  const items = unit.items.map((i) => `${i.source}:${i.key}`)
  for (let n = 1; n <= MAX_SUFFIX; n++) {
    const branch = n === 1 ? unit.branch : `${unit.branch}-${n}`
    if (!(await forge.branchExists(unit.repo, branch))) return { branch }
    const prs = await forge.prsOn(unit.repo, branch)
    if (prs.length === 0 && hasTrailer(await forge.tipMessage(unit.repo, branch)))
      return { skip: `${branch} exists on ${unit.repo} without a PR; delete it to run again` }
    const tried = prs.find(
      (pr) => !pr.merged && footerItems(pr.body).some((item) => items.includes(item)),
    )
    if (tried)
      return { skip: `awaywork tried this in ${tried.url}; delete ${branch} to run it again` }
  }
  return { skip: `${unit.branch} to ${unit.branch}-${MAX_SUFFIX} already exist on ${unit.repo}` }
}

/** A loop of the chain, while its rounds run. */
interface OpenLoop {
  skills: string[]
  rounds: number
  verdict?: string
  /** The last run of `until`'s command. */
  check?: RanCheck
  ended?: string
}

type StepReport = { id: string; skill: string; text: string }

interface Check {
  output: string
  failed?: string
  /** Cut short by Ctrl-C or the window's end: the condition is unknown, not false. */
  stopped?: true
  /** Hit the time limit: a `when` can't tell it from a negated check that passed, so it isn't false either. */
  timedOut?: true
  /** Never runs on this unit: a `when` on it doesn't hold, and an `until` can't. */
  refused?: true
}

type RanCheck = Check & { command: string }

const refusal = (failed: string): Check => ({ output: '', failed, refused: true })

const git = async (dir: string, ...args: string[]) =>
  (await execa(bin('git'), ['-C', dir, ...args])).stdout

const head = (dir: string) => git(dir, 'rev-parse', 'HEAD')

/** `git status --porcelain` lines, one per uncommitted path; a nested repo's own config runs nothing. */
async function uncommitted(dir: string): Promise<string[]> {
  const status = ['status', '--porcelain', '--ignore-submodules=dirty']
  return (await git(dir, '-c', 'core.fsmonitor=false', ...status)).split('\n').filter(Boolean)
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

/** What a step left for the chain, e.g. `2 commits and a report`. */
function made(commits: number, report: string): string {
  const parts = [commits > 0 && `${commits} commits`, report && 'a report'].filter(Boolean)
  return parts.length ? parts.join(' and ') : 'nothing'
}

/** The latest report of each skill: a loop's last review stands for its earlier ones. */
function latestReports(reports: StepReport[]): StepReport[] {
  return reports.filter((r, i) => !reports.slice(i + 1).some((later) => later.skill === r.skill))
}

function joinReports(reports: StepReport[]): string {
  return latestReports(reports)
    .map((r) => `### ${r.id}\n\n${r.text}`)
    .join('\n\n')
}

/** Saves a step's own commits for the next, and clears what only it wrote from the shared clone. */
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

/** E.g. `2 rounds of review ⇄ fix; until held: verdict approve`. */
function describeLoop(loop: OpenLoop): string {
  const rounds = `${loop.rounds} ${loop.rounds === 1 ? 'round' : 'rounds'}`
  return `${rounds} of ${loop.skills.join(' ⇄ ')}; ${loop.ended ?? 'nothing ran'}`
}

/** awaywork's own notes in the PR body or push summary: how each loop went, its failing check, and the steps' reports. */
async function appendChainNotes(file: string, reports: StepReport[], loops: OpenLoop[]) {
  const body = (await readOutput(file)).trim()
  if (!body || (reports.length === 0 && loops.length === 0)) return
  const lines = ['', '', '## Awaywork chain']
  for (const loop of loops) {
    const verdict = loop.verdict ? `; last verdict ${loop.verdict}` : ''
    lines.push('', `Loop: ${describeLoop(loop)}${verdict}.`)
    const { check } = loop
    if (check?.failed && !check.refused)
      lines.push(
        '',
        checkDetails(
          `Last check: \`${check.command}\` ${check.stopped ? 'stopped' : 'failed'}`,
          check,
        ),
      )
  }
  for (const r of latestReports(reports))
    lines.push('', `<details><summary>Report: ${r.id}</summary>`, '', r.text, '', '</details>')
  await writeOutput(file, `${body}${lines.join('\n')}\n`)
}

/** A collapsible block with the command and the tail of its output. */
function checkDetails(summary: string, check: RanCheck): string {
  const log = checkLog(check).trim()
  const fence = '`'.repeat(Math.max(3, ...[...log.matchAll(/`+/g)].map((m) => m[0].length + 1)))
  return [`<details><summary>${summary}</summary>`, '', fence, log, fence, '', '</details>'].join(
    '\n',
  )
}

/** Appends a failed `verify` to the PR body or push report, so the reviewer sees it before the diff. */
async function appendVerifyFailure(file: string, check: RanCheck): Promise<void> {
  const body = (await readOutput(file)).trim()
  if (!body) return
  const verb = check.refused ? 'not run' : check.stopped ? 'stopped' : 'failed'
  const summary = `Verify \`${check.command}\` ${verb}: ${check.failed}`
  await writeOutput(file, `${body}\n\n## Awaywork verify\n\n${checkDetails(summary, check)}\n`)
}

/** With every secret withheld except the repo's own. */
function setupEnv(
  env: NodeJS.ProcessEnv,
  dir: string,
  secrets: string[],
  own: string[],
): NodeJS.ProcessEnv {
  const passed = own.filter((name) => env[name] !== undefined).map((name) => [name, env[name]])
  return { ...commandEnv(env, dir, secrets), ...Object.fromEntries(passed) }
}
