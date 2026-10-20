import { createWriteStream, existsSync } from 'node:fs'
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { Config } from '../config/schema.js'
import type { Attempts } from '../core/attempts.js'
import { MAX_TURNS, quotaFacts, route, withQuota } from '../core/budget.js'
import { describeCondition, holds } from '../core/condition.js'
import { bySlice, describeChain, type PlannedUnit, type RunPlan, slug } from '../core/foreman.js'
import type { RunReport, UnitResult } from '../core/report.js'
import type { Ctx, Forge, Item, McpServer, Provider, Quota, Source } from '../core/types.js'
import { commitsSince, createChecks, head, untilHolds } from './checks.js'
import { fetchContexts } from './context.js'
import { notifyUnit } from './notify.js'
import type { Stack } from './publish.js'
import type { ReplayState } from './replay.js'
import { runWorker, type WorkerOptions } from './run.js'
import { maskSecrets, runSetup } from './setup.js'
import {
  cutBranch,
  describeLoop,
  freeBranch,
  type OpenLoop,
  type Publisher,
  publishSlice,
  type StepReport,
} from './slices.js'
import { handOff, isLast, made, maxReached, readVerdict, setupEnv } from './steps.js'
import {
  configSecrets,
  notSymlink,
  outputFile,
  type Previous,
  prepareWorkspace,
  readOutput,
  refuseSymlinks,
  WORK_DIR,
  workerEnv,
} from './workspace.js'

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
  /** Earlier attempts: a chain's first step on an item gets the item's latest report. */
  attempts?: Attempts
}

/** The latest report an earlier run left on one of the items. */
async function earlierReport(
  items: Item[],
  attempts: Attempts,
  runsDir: string,
  thisRun: string,
): Promise<Previous | undefined> {
  for (const item of items) {
    const last = attempts[`${item.source}:${item.key}`]?.report
    if (!last || last.runId === thisRun) continue
    const out = join(runsDir, last.runId, 'units', last.unit, last.step, 'out')
    if ((await readOutput(join(out, outputFile.report))).trim())
      return { skill: last.skill, out, earlierRun: last.runId }
  }
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
 * clone, and each slice of the chain publishes once, when it ends: its commits as a draft PR or a
 * push onto your PR, else its reports. A draft PR stacks on the awaywork PR a rule took up, or on
 * the slice before, whose pushed tip the next slice's commits are published onto.
 * Every step leaves `units/<id>/<n>-<skill>/` in the run dir: its context, prompt, output and worker
 * log; what each slice published is in `units/<id>/out/`, `out-2/` and so on.
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

  const { check, factsFor, restoreGit, rememberGitConfig, baseline } = createChecks({
    env: input.ctx.env,
    secrets,
    signal: input.signal,
    until: input.until,
  })
  const publisher: Publisher = {
    forge: input.forge,
    runId: input.runId,
    signal: input.signal,
    check,
  }

  /** Runs notify for each step of a finished chain: its own output, and its slice's PR. Once interrupted, none starts. */
  const notifyUnits = async (chain: UnitResult[]) => {
    const hook = input.config.notify
    if (!hook || input.dryRun) return
    for (const slice of bySlice(chain, (r) => r.planned.slice)) {
      const outcome = slice.find((r) => r.outcome)?.outcome
      const pr = outcome?.kind === 'pr' ? outcome.url : undefined
      for (const r of slice) {
        if (input.signal?.aborted) return
        const { id, skill, deliver } = r.planned.unit
        const chainId = r.planned.chain ?? id
        const out =
          r.step && join(input.runDir, 'units', chainId, r.step, 'out', outputFile[deliver])
        const failure = await notifyUnit(
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
          input.ctx.log(`notify failed for ${id}: ${maskSecrets(failure, secrets, input.ctx.env)}`)
      }
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
    // The open slice's base, branch and the PR it stacks on: the awaywork PR a rule took up, or the slice before's.
    const shape = {
      base,
      branch: first.unit.branch,
      stackedOn: deliver === 'draft_pr' ? pickedUp?.url : undefined,
    }
    // `changed` diffs from where the chain started: the awaywork PR it took up, else the default branch.
    const since = pickedUp ? base : ''
    const dir = join(input.runDir, 'work', first.unit.id)
    const chainDir = join(input.runDir, 'units', first.unit.id)
    const steps = chain.length > 1 ? describeChain(chain) : undefined
    const slices = bySlice(chain, (p) => p.slice).length
    // Slices publish from one repo of awaywork's own, where the next sits on the commits the one before pushed.
    const stack: Stack | undefined =
      slices > 1 ? { repo: join(input.runDir, 'publish', first.unit.id) } : undefined
    // Branches this chain published: a later slice passes them over, not taking them for an earlier attempt.
    const published = new Set<string>()
    let at = 0
    let opening = first
    let loops: Record<number, OpenLoop> = {}
    let reports: StepReport[] = []
    let cloned: string | undefined
    // Where the open slice's commits start in the clone, and whether its branch is still to be cut there.
    let from: string | undefined
    let cut = false
    let previous: Previous | undefined
    let verdict: string | undefined
    let ran = false
    let interrupted = false
    // Why the steps left didn't run, and whether they're passed over rather than missed.
    let ended: { reason: string; passedOver?: true } | undefined

    /** Publishes the open slice once its last step ended; after its draft PR, the next slice is cut at the clone's tip. */
    const endSlice = async (last: boolean) => {
      const lead = done.find((r) => r.planned.unit.id === opening.unit.id && r.status !== 'skipped')
      const out = join(chainDir, at > 0 ? `out-${at + 1}` : 'out')
      if (from !== undefined && lead && ran && !input.dryRun) {
        if (Object.keys(loops).length) lead.loop = Object.values(loops).map(describeLoop).join('; ')
        interrupted ||= !!input.signal?.aborted
        try {
          lead.outcome = interrupted
            ? { kind: 'none', reason: 'interrupted', unpublished: true }
            : await publishSlice(
                publisher,
                { ...first.unit, ...shape, deliver },
                dir,
                from,
                reports,
                loops,
                stack,
                // Only the whole chain, cut from the default branch, closes its issues.
                last && !first.capped && base === '',
              )
        } catch (e) {
          Object.assign(lead, { status: 'error', reason: (e as Error).message })
        } finally {
          await cp(join(dir, WORK_DIR, 'out'), out, { recursive: true, filter: notSymlink }).catch(
            () => {},
          )
        }
      }
      if (last || ended) return
      const outcome = lead?.outcome
      if (outcome?.kind === 'pr') {
        if (stack) stack.onto = outcome.head
        shape.stackedOn = outcome.url
        if (previous)
          previous.published = { url: outcome.url, body: join(out, outputFile.draft_pr) }
      } else if (!input.dryRun) {
        ended = { reason: `${opening.unit.id} opened no draft PR to stack on`, passedOver: true }
        return
      }
      published.add(shape.branch)
      shape.base = shape.branch
      cut = true
      try {
        // The next slice's commits are those after the clone's tip, and it writes its own PR body.
        from = await head(dir)
        await refuseSymlinks(dir, [`${WORK_DIR}/out`])
        await rm(join(dir, WORK_DIR, 'out'), { recursive: true, force: true })
      } catch (e) {
        ended = { reason: `${opening.unit.id} error: ${(e as Error).message}` }
      }
    }

    for (const p of chain) {
      if ((p.slice ?? 0) !== at) {
        await endSlice(false)
        at = p.slice ?? 0
        opening = p
        loops = {}
        reports = []
        ran = false
      }
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
      if ((cloned === undefined || cut) && deliver === 'draft_pr') {
        const named = p.unit.branch
        const free = await freeBranch(input.forge, p.unit, published).catch((e: Error) => ({
          skip: `couldn't check ${named} on ${unit.repo}: ${e.message}`,
        }))
        if ('skip' in free) {
          end(free.skip)
          continue
        }
        if (free.branch !== named)
          input.ctx.log(`${unit.id}: ${named} is taken on ${unit.repo}, using ${free.branch}`)
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
        if (cut) {
          await cutBranch(dir, unit.branch)
          cut = false
        }
        const prompt = await prepareWorkspace({
          ...input,
          unit,
          dir,
          plugin,
          provider,
          ctx,
          previous:
            previous ??
            (reuse
              ? undefined
              : await earlierReport(
                  unit.items,
                  input.attempts ?? {},
                  dirname(input.runDir),
                  input.runId,
                )),
          reuse,
          chain: steps,
          slice: slices > 1 ? { n: at + 1, of: slices } : undefined,
          loop: p.loop,
        })
        if (!reuse) {
          // Before setup or any worker touched the clone: the chain's commits are the ones after it.
          cloned = from = await head(dir)
          rememberGitConfig(dir, await readFile(join(dir, '.git', 'config'), 'utf8'))
          const state: ReplayState = { unit, provider: id, commit: cloned }
          await writeFile(join(unitDir, 'replay.json'), `${JSON.stringify(state, null, 2)}\n`)
        }
        if (input.dryRun) continue
        const a = allowances[id]
        if (!a) continue
        if (!reuse)
          await fetchContexts(unit.items, dir, { ...input, env: input.ctx.env, secrets, log })
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
        if (!reuse) await baseline(dir)
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
            // A rule's own `when` gates its whole chain, and a stacked step's the rest of it.
            if (p === opening) ended = { reason, passedOver: true }
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
        if (report) {
          reports.push({ id: unit.id, skill: unit.skill, text: report })
          result.reported = true
        }
        result.made = made(commits, report)
        // What the next step works from: a committing step's commits, a report step's report.
        const left = unit.deliver === 'report' ? report !== '' : commits > 0
        if (worker.status === 'stopped: aborted' || input.signal?.aborted) {
          interrupted = true
          ended = { reason: 'interrupted' }
        } else if (worker.status !== 'done') ended = { reason: `${unit.id} ${worker.status}` }
        else if (!left) {
          const reason = `${unit.id} ${unit.deliver === 'report' ? 'wrote no report' : 'committed nothing'}`
          // Inside a loop it ends only the loop, and the steps after it still run; a stacked slice's first step leaves it nothing.
          if (loop && !(at > 0 && p === opening)) loop.ended = reason
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
        // Before a first step's workspace is prepared, the clone's `.away` may be the branch's.
        if (cloned !== undefined)
          await cp(join(dir, WORK_DIR), unitDir, {
            recursive: true,
            // The unit dir's replay.json and worker.log are awaywork's: the clone's never replace them.
            force: false,
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

    await endSlice(true)
    if (!input.dryRun) await rm(dir, { recursive: true, force: true })
    if (stack) await rm(stack.repo, { recursive: true, force: true })
    return done
  }

  for (const chain of chains) {
    const done = await runChain(chain)
    results.push(...done)
    await notifyUnits(done)
  }

  const { runId, dryRun, plan } = input
  return { runId, dryRun, startedAt, finishedAt: new Date(), plan, results, quotas }
}
