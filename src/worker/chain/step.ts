import { createWriteStream } from 'node:fs'
import { appendFile, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { configDir, defaultConfigPath, profilesPath, rootStateDir } from '#config/paths'
import { readRegistry } from '#config/profiles'
import { grantedNetwork, setupPhase } from '#core/egress'
import {
  AGENT_HOME,
  CONTAINER_HOME,
  contain,
  contained,
  lostToWorker,
  whereRuns,
} from '#core/isolation'
import { withholdsGrants } from '#core/trust'
import type { McpServer, Unit } from '#core/types'
import { shellRefusal, wallUp } from '#core/wall'
import { describeCondition, holds } from '#plan/condition'
import { modelFor, modelsFor, type PlannedUnit, slug } from '#plan/foreman'
import { settingsFor } from '#plan/repos'
import type { UnitResult } from '#posts/report'
import { MAX_TURNS, modelOver, quotaFacts, route, withQuota } from '#quota/budget'
import { bounded, counted } from '#util/text'
import { fetchContexts } from '#worker/clone/context'
import { commandEnv, gateEnv, setupEnv, workerEnv } from '#worker/clone/env'
import {
  copyOut,
  notSymlink,
  outputFile,
  readOutput,
  refuseSymlinks,
  reportsOnly,
  WORK_DIR,
  writeOutput,
} from '#worker/clone/files'
import { commitsSince, git, head } from '#worker/clone/git'
import { prepareWorkspace } from '#worker/clone/workspace'
import { freeBranch, prependSection } from '#worker/deliver/slice'
import { untilHolds } from '#worker/process/checks'
import { maskSecrets, runSetup } from '#worker/process/command'
import { serveRequest } from '#worker/process/serve'
import { shortage } from '#worker/process/watchdog'
import { runWorker } from '#worker/process/worker'
import { lastReport } from '#worker/units/ready'
import type { Run } from '#worker/units/state'
import {
  discard,
  handOff,
  isLast,
  made,
  maxReached,
  readStatus,
  readVerdict,
  snapshot,
} from './handoff'
import { concludeMerge, conflictsFile, leaveConflicts, type Merge, mergeBase } from './merge'
import type { ReplayState } from './replay'
import { type ChainState, leave } from './state'

/** Copies the clone's `.away/` to a step's folder, but for gh's, twg's, the container's and the agent's homes. */
const copyStep = (dir: string, unitDir: string) =>
  copyOut(join(dir, WORK_DIR), unitDir, {
    // The unit dir's replay.json and worker.log are awaywork's: the clone's never replace them.
    force: false,
    filter: async (src) =>
      ![
        join(dir, WORK_DIR, 'gh'),
        join(dir, WORK_DIR, 'twg'),
        join(dir, CONTAINER_HOME),
        join(dir, AGENT_HOME),
      ].includes(src) && (await notSymlink(src)),
  }).catch(() => {})

const inside = (path: string, folder: string) => {
  const rel = relative(folder, path)
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

/** The real path of `path`, a missing tail kept as written under its nearest existing folder. */
async function real(path: string): Promise<string> {
  try {
    return await realpath(path)
  } catch {
    const parent = dirname(path)
    return parent === path ? path : join(await real(parent), basename(path))
  }
}

const registeredConfigs = () => {
  try {
    return Object.values(readRegistry(profilesPath).profiles)
  } catch {
    return []
  }
}

/** The unit's `writable` paths that exist, as real paths, `~/` as the developer's home; none from an untrusted author or in a container, a skipped or refused one logged. */
export async function writablePaths(
  unit: Unit,
  dir: string,
  log: (line: string) => void,
  loaded: (string | undefined)[] = [],
) {
  const written = unit.writable ?? []
  if (written.length === 0) return []
  if ('image' in whereRuns(dir)) {
    log('writable: not applied under isolation: container')
    return []
  }
  if (withholdsGrants(unit)) {
    log("writable: not opened, an author isn't on trust")
    return []
  }
  const home = await real(homedir())
  const own = await Promise.all(
    [
      configDir,
      dirname(defaultConfigPath),
      rootStateDir,
      ...registeredConfigs().map(dirname),
      ...loaded.filter((folder) => folder !== undefined),
    ].map(real),
  )
  const found: string[] = []
  for (const path of written) {
    const full = resolve(path.startsWith('~/') ? join(homedir(), path.slice(2)) : path)
    const resolved = await realpath(full).catch(() => undefined)
    const clash =
      resolved && own.find((folder) => inside(folder, resolved) || inside(resolved, folder))
    if (!resolved) log(`writable: ${path} doesn't exist, skipped`)
    else if (inside(home, resolved)) log(`writable: ${path} holds your home, refused`)
    else if (clash) log(`writable: ${path} overlaps awaywork's own ${clash}, refused`)
    else if (!found.includes(resolved)) {
      if (resolved !== full) log(`writable: ${path} is ${resolved}`)
      found.push(resolved)
    }
  }
  return found
}

/**
 * What follows awaywork's own merge when no worker resolves it: setup only when there's a `verify` to need it,
 * then a clean merge publishes as a push. A conflict isn't an attempt: the next run, reading it, plans a provider.
 * One no worker can resolve is the developer's.
 */
async function settle(
  run: Run,
  cs: ChainState,
  unit: Unit,
  merge: Merge,
  result: UnitResult,
  log: (line: string) => void,
) {
  const { input, secrets, event, restoreGit, baseline } = run
  const { pickedUp, dir } = cs
  const settings = settingsFor(input.config.repos, unit.repo)
  if (merge.kind === 'merged' && unit.verify && settings.setup && !unit.untrusted) {
    const own = pickedUp ? [] : settings.secrets
    const env = setupEnv(input.ctx.env, dir, secrets, own)
    const options = {
      secrets: own,
      signal: input.signal,
      until: input.until,
      egress: setupPhase(grantedNetwork(unit), log),
    }
    const failed = await runSetup(settings.setup, dir, env, log, options)
    if (failed) {
      Object.assign(result, { status: 'skipped', reason: failed })
      event(`${unit.id}: skipped, ${failed.split('\n')[0]}`)
      cs.ended = { reason: `${unit.id} setup failed` }
      return
    }
    await restoreGit(dir)
  }
  await baseline(dir)
  const into = unit.merge as string
  if (merge.kind === 'conflicts' && merge.byHand) {
    result.status = 'done'
    result.outcome = {
      kind: 'none',
      reason: `conflicts with ${into} in ${merge.byHand}: merge it by hand`,
    }
  } else if (merge.kind === 'conflicts')
    Object.assign(result, {
      status: 'skipped',
      reason: `conflicts with ${into} in ${merge.paths.join(', ')}, and no provider to resolve them`,
    })
  else if (merge.kind === 'current') {
    result.status = 'done'
    result.outcome = { kind: 'none', reason: `already up to date with ${into}` }
  } else {
    result.status = 'done'
    cs.merged = merge.commit
    cs.ran = true
    result.made = `a merge of ${counted(merge.commits, 'commit')}`
  }
}

/**
 * A merging skill's one step with no provider: awaywork merges the PR's base `into` the clone itself, with no worker,
 * before setup runs, and aborts a merge that conflicts.
 */
async function mergeStep(run: Run, cs: ChainState, p: PlannedUnit, into: string) {
  const { input, secrets, event, root, rememberGitConfig } = run
  const { shape, chainDir, dir, done } = cs
  const unit = { ...p.unit, ...shape }
  const step = `1-${slug(unit.skill)}`
  const unitDir = join(chainDir, step)
  const plugin = join(root, 'plugins', unit.id)
  const image = settingsFor(input.config.repos, unit.repo).image
  if (contained() && image) contain(dir, { image, plugin, secrets })
  await mkdir(unitDir, { recursive: true })
  const logFile = createWriteStream(join(unitDir, 'worker.log'))
  const log = (line: string) => logFile.write(`${new Date().toISOString()} ${line}\n`)
  const result: UnitResult = { planned: p, status: 'prepared', step }
  done.push(result)
  event(`${unit.id}: ${unit.skill}, merging ${into} with no model`)
  try {
    await prepareWorkspace({ ...input, unit, dir, plugin, ctx: { ...input.ctx, log } })
    cs.cloned = cs.from = cs.original = await head(dir)
    rememberGitConfig(dir, await readFile(join(dir, '.git', 'config'), 'utf8'))
    if (input.dryRun) return
    // Before setup runs, on a fresh git config as a gate's: only the branch and its base, as cloned, steer the merge.
    const env = await gateEnv(input.ctx.env, dir, secrets)
    await settle(run, cs, unit, await mergeBase(dir, into, unit.base, env, log), result, log)
  } catch (e) {
    Object.assign(result, { status: 'error', reason: (e as Error).message })
    log(`error: ${(e as Error).stack}`)
    cs.ended = { reason: `${unit.id} error: ${(e as Error).message}` }
  } finally {
    await new Promise((done) => logFile.end(done))
    if (cs.cloned !== undefined && !lostToWorker(dir)) await copyStep(dir, unitDir)
    if (!input.dryRun) await rm(plugin, { recursive: true, force: true })
  }
  event(`${unit.id}: ${result.status}`)
}

/** Runs step `i` of the chain, or lists it skipped; one that failed and retries leaves `retrying` set, to run `i` again. */
export async function runStep(run: Run, cs: ChainState, i: number) {
  const { input, secrets, event, root, allowances, routed, quotas } = run
  const { factsFor, restoreGit, rememberGitConfig, baseline } = run
  const { chain, done, first, base, deliver, opensPr, resume, pickedUp, shape } = cs
  const { dir, chainDir, steps, loops, reports, shipped, pinned } = cs
  const p = chain[i] as PlannedUnit
  const retryOf = cs.retrying
  cs.retrying = undefined
  if (p.loop) loops[p.loop.at] ??= { skills: p.loop.skills, rounds: 0 }
  const loop = p.loop && loops[p.loop.at]
  // A loop's later rounds run only while it goes on: once the chain ended, or in a dry run, only its first is listed.
  if (loop?.ended || ((cs.ended || input.dryRun) && p.loop && p.loop.round > 1)) return
  const skip = (reason: string, passedOver?: true) =>
    done.push({ planned: p, status: 'skipped', reason, ...(passedOver && { passedOver }) })
  const end = (reason: string) => {
    // A retry that can't start leaves the failed attempt standing, as without a model list.
    if (retryOf) {
      retryOf.result.reason ??= `not retried: ${reason}`
      retryOf.keep()
      reason = `${p.unit.id} ${retryOf.result.status}, not retried: ${reason}`
    } else skip(reason)
    cs.ended = { reason }
    if (loop) loop.ended ??= reason
  }
  if (cs.ended) {
    skip(cs.ended.reason, cs.ended.passedOver)
    return
  }
  if (input.signal?.aborted) {
    cs.interrupted = true
    end('interrupted')
    return
  }
  if (input.until && new Date() >= input.until) {
    end('the window ended')
    return
  }
  const short = await (input.shortage ?? shortage)(dir)
  if (short) {
    end(short)
    return
  }
  const image = settingsFor(input.config.repos, p.unit.repo).image
  if (contained() && !image) {
    end(`no image for ${p.unit.repo}: isolation: container needs one in its repos entry`)
    return
  }
  const unit = { ...p.unit, ...shape }
  const candidates = retryOf ? [retryOf.result.provider as string] : unit.providers
  // A model whose own window is full passes its turn to the next; a retry has only the second.
  const tries = (on: string) => {
    const all = modelsFor(unit.rule.model, on, input.config.providers)
    return retryOf ? all.slice(-1) : all
  }
  const { provider: id, passed, model: next = 0 } = route(candidates, allowances, routed, tries)
  const provider = id && input.providers[id]
  // A merge planned with no conflict to resolve, or with no provider left for it, still merges what's clean.
  if (p.unit.merge && (!p.provider || !provider)) {
    await mergeStep(run, cs, p, p.unit.merge)
    return
  }
  if (!id || !provider) {
    end(`no provider left: ${passed.join('; ') || 'none configured'}`)
    return
  }
  const refused = await shellRefusal(provider, { dir }, input.signal)
  if (refused) {
    end(refused)
    return
  }
  // A resumed draft's branch is the unit's own: no other name to find.
  if (cs.cloned === undefined && opensPr && !shape.resume) {
    const named = p.unit.branch
    const free = await freeBranch(input.forge, p.unit).catch((e: Error) => ({
      skip: `couldn't check ${named} on ${unit.repo}: ${e.message}`,
    }))
    if ('skip' in free) {
      end(free.skip)
      return
    }
    if (free.taken)
      input.ctx.log(`${unit.id}: ${free.taken} is taken on ${unit.repo}, using ${free.branch}`)
    shape.branch = unit.branch = free.branch
  }
  routed[id] = (routed[id] ?? 0) + 1
  if (retryOf) retryOf.result.retried = true
  const entry = input.config.providers.find((c) => c.id === id)
  const attempt = retryOf ? 1 : next
  const model = modelFor(unit.rule.model, id, attempt) ?? entry?.model
  if (next > 0) {
    const first = modelFor(unit.rule.model, id, 0)
    const over = allowances[id] && modelOver(allowances[id], first)
    input.ctx.log(`${unit.id}: ${first} at its ceiling (${over}), starting on ${model}`)
  }
  if (retryOf) input.ctx.log(`${unit.id}: ${retryOf.result.status}, retrying on ${model}`)
  const starts = `${unit.id}: ${unit.skill} on ${id}${model ? ` (${model})` : ''}`
  // A unit its `when` or `quota` may pass over says it starts only once that held.
  const gated = !!(unit.rule.when ?? unit.rule.quota) && !retryOf && !input.dryRun
  if (!gated) event(starts)

  const step = `${done.filter((r) => r.step).length + 1}-${slug(unit.skill)}`
  const unitDir = join(chainDir, step)
  const plugin = join(root, 'plugins', unit.id)
  if (contained() && image) contain(dir, { image, plugin, secrets })
  await mkdir(unitDir, { recursive: true })
  const logFile = createWriteStream(join(unitDir, 'worker.log'))
  const log = (line: string) => logFile.write(`${new Date().toISOString()} ${line}\n`)
  if (wallUp() && provider.startsSandbox && !(await provider.startsSandbox({ dir }, input.signal)))
    log(
      `network: ${id}'s shell sandbox can't start here: its shell reaches the CLI's hosts and \`network\` through awaywork's wall`,
    )
  const result: UnitResult = {
    planned: { ...p, unit: { ...p.unit, branch: unit.branch } },
    provider: id,
    status: 'prepared',
    step,
  }
  done.push(result)
  let start: string | undefined
  try {
    const whenLog = join(dir, WORK_DIR, 'context', 'previous', 'when.log')
    // A retry skips its `when`, which held on this same clone, and keeps the check's output.
    const checked = retryOf && (await readOutput(whenLog))
    if (retryOf) await discard(dir, retryOf.start, retryOf.saved)
    const ctx = { ...input.ctx, log }
    const reuse = cs.cloned !== undefined
    const prompt = await prepareWorkspace({
      ...input,
      unit,
      dir,
      plugin,
      provider,
      ctx,
      // A retried first step gets the earlier report again: setting up the clone wiped it.
      previous:
        cs.previous ?? (reuse && !retryOf ? undefined : await lastReport(run, unit, chainDir)),
      reuse,
      shipped,
      pinned,
      chain: steps,
      loop: p.loop,
    })
    if (checked) {
      await mkdir(dirname(whenLog), { recursive: true })
      await writeOutput(whenLog, checked)
    }
    if (!reuse) {
      // Before setup or any worker touched the clone: the chain's commits are the ones after it.
      cs.cloned = cs.from = await head(dir)
      if (chain.some((c) => c.unit.rule.when?.changed || c.loop?.until.changed))
        cs.since = await git(dir, 'rev-parse', `origin/${pickedUp ? base : 'HEAD'}`)
      cs.original =
        resume?.from ??
        (pickedUp && unit.gates ? await git(dir, 'merge-base', 'origin/HEAD', 'HEAD') : cs.cloned)
      rememberGitConfig(dir, await readFile(join(dir, '.git', 'config'), 'utf8'))
      const state: ReplayState = { unit, provider: id, commit: cs.cloned }
      await writeFile(join(unitDir, 'replay.json'), `${JSON.stringify(state, null, 2)}\n`)
    }
    if (input.dryRun) return
    const a = allowances[id]
    if (!a) return
    if (unit.merge && !reuse) {
      // Before anything else runs, as with no provider; a merge that turns out clean spends nothing.
      const env = await gateEnv(input.ctx.env, dir, secrets)
      const merge = await mergeBase(dir, unit.merge, unit.base, env, log, true)
      if (merge.kind !== 'conflicts' || merge.byHand) {
        routed[id] = (routed[id] ?? 1) - 1
        delete result.provider
        await settle(run, cs, unit, merge, result, log)
        event(`${unit.id}: ${result.status}`)
        return
      }
      cs.resolving = await leaveConflicts(dir, merge, unit.merge, unit.base, env)
    }
    if (!reuse) await fetchContexts(unit.items, dir, { ...input, env: input.ctx.env, secrets, log })
    const settings = settingsFor(input.config.repos, unit.repo)
    if (!reuse && settings.setup && !unit.untrusted) {
      // An awaywork PR's branch a worker wrote runs install scripts you didn't write: they get none of the repo's secrets.
      const own = pickedUp ? [] : settings.secrets
      const failed = await runSetup(
        settings.setup,
        dir,
        setupEnv(input.ctx.env, dir, secrets, own),
        log,
        {
          secrets: own,
          signal: input.signal,
          until: input.until,
          egress: setupPhase(grantedNetwork(unit), log),
        },
      )
      // A conflicted lockfile, say, fails an install: the worker resolves the merge all the same.
      if (failed && cs.resolving) {
        await refuseSymlinks(dir, [conflictsFile])
        const again = `\nSetup failed on the conflicted tree: run \`${settings.setup}\` again once they're resolved, if a check needs it.\n`
        await writeOutput(join(dir, conflictsFile), again, true)
      } else if (failed) {
        Object.assign(result, { status: 'skipped', reason: failed })
        event(`${unit.id}: skipped, ${failed.split('\n')[0]}`)
        cs.ended = { reason: `${unit.id} setup failed` }
        return
      }
      await restoreGit(dir)
    }
    if (!reuse) await baseline(dir)
    const when = unit.rule.when ?? unit.rule.quota
    if (when && !retryOf) {
      const shown = `${unit.rule.when ? 'when' : 'quota:'} ${describeCondition(when)}`
      const met = await factsFor(when, unit, dir, cs.since, cs.verdict, log, whenLog, {
        from: cs.from,
      })
      Object.assign(met.facts, quotaFacts(a))
      // A check stopped or timed out before it exited says nothing: the chain ends without passing over it.
      if (met.check?.stopped || met.check?.timedOut) {
        const reason = `${shown} not checked: ${met.check.failed}`
        Object.assign(result, { status: 'skipped', reason })
        event(`${unit.id}: skipped, ${reason}`)
        routed[id] = (routed[id] ?? 1) - 1
        cs.ended = { reason }
        cs.interrupted ||= !!input.signal?.aborted
        return
      }
      if (!holds(when, met.facts)) {
        const failed = met.check?.failed ? ` (${met.check.failed})` : ''
        const reason = `${shown} didn't hold${failed}`
        Object.assign(result, { status: 'skipped', reason, passedOver: true })
        event(`${unit.id}: skipped, ${reason}`)
        routed[id] = (routed[id] ?? 1) - 1
        // A rule's own `quota` gates its whole chain.
        if (p === first) cs.ended = { reason, passedOver: true, when: true }
        // A refused check is refused every round: the loop would repeat without its step.
        else if (loop && p.loop && met.check?.refused) loop.ended = reason
        else if (loop && p.loop && p.loop.step === p.loop.skills.length - 1) {
          // A round where no step ran left nothing: the next one would pass over the same.
          const idle = loop.rounds < p.loop.round
          if (idle) loop.ended = "no step's when held"
          else if (isLast(p.loop)) loop.ended = maxReached(p.loop.max)
        }
        return
      }
    }
    if (gated) event(starts)
    const maxTurns = a.kind === 'fallback' ? a.turns : MAX_TURNS
    const named = unit.rule.mcp ?? []
    const bare = withholdsGrants(unit)
    if (named.length > 0 && bare)
      log(`mcp: ${named.join(', ')} not started, an author isn't on trust`)
    if (unit.network?.length && bare) log("network: not opened, an author isn't on trust")
    const writable = await writablePaths(unit, dir, log, [input.configDir, input.config.baseDir])
    const mcp: Record<string, McpServer> = {}
    for (const name of bare ? [] : named) {
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
      writable,
    }
    if (a.kind === 'quota') result.baseline = { name: a.window, used: a.used, resetsAt: a.resetsAt }
    start = await head(dir)
    const retryable = attempt === 0 && Array.isArray(unit.rule.model?.[id])
    const saved = retryable ? await snapshot(dir) : undefined
    cs.ran = true
    const worker = await runWorker(provider, job, a, {
      log,
      signal: input.signal,
      until: input.until,
      maxMinutes: input.config.limits.unit_minutes,
      watch: input.watch,
      serve: serveRequest(
        unit,
        settings.serve,
        join(unitDir, 'serve.log'),
        commandEnv(input.ctx.env, dir, secrets),
      ),
    })
    await restoreGit(dir)
    for (const line of (await provider.finish?.(dir)) ?? []) log(line)
    Object.assign(result, worker)
    if (worker.reason) result.reason = maskSecrets(worker.reason, secrets, input.ctx.env)
    if (loop && p.loop) loop.rounds = p.loop.round
    if (worker.quota) {
      quotas[id] = worker.quota
      allowances[id] = withQuota(a, worker.quota, model)
    }
    result.verdict = await readVerdict(dir)
    const commits = await commitsSince(dir, start)
    const report = (await readOutput(join(dir, WORK_DIR, 'out', outputFile.report))).trim()
    const questions = (await readOutput(join(dir, WORK_DIR, 'out', 'questions.md'))).trim()
    const status = await readStatus(dir)
    if (status && status !== 'done' && status !== 'ask' && status !== 'continue')
      input.ctx.log(`${unit.id}: status "${status}" isn't done, ask or continue, read as none`)
    if (status === 'ask' && !questions)
      input.ctx.log(`${unit.id}: status ask without questions.md, read as none`)
    // Going on needs somewhere to keep the count: the draft it resumes or opens, or the result of a report.
    const kept =
      deliver === 'report'
        ? !!report
        : opensPr &&
          (!!shape.resume || (cs.from !== undefined && (await commitsSince(dir, cs.from)) > 0))
    if (status === 'continue' && !kept)
      input.ctx.log(
        `${unit.id}: status continue with ${opensPr || deliver === 'report' ? 'nothing to go on from' : `deliver ${deliver}`}, read as none`,
      )
    // Unless it says it asks, a step that committed went on: its questions aren't the chain's to ask.
    const asks = !!questions && (status === 'ask' || reportsOnly(unit.deliver) || commits === 0)
    result.made = made(commits, report, asks ? questions : '')
    // awaywork concludes the merge the worker resolved, from its working tree, and nothing setup or it committed.
    if (cs.resolving && (await head(dir)) !== cs.resolving.start)
      cs.unmerged = `HEAD moved since the clone: awaywork makes the merge, not pushed`
    else if (cs.resolving && worker.status === 'done' && !asks) {
      const env = await gateEnv(input.ctx.env, dir, secrets)
      const concluded = await concludeMerge(dir, cs.resolving, unit.base, env)
      if ('refused' in concluded) cs.unmerged = concluded.refused
      else {
        cs.merged = concluded.commit
        result.made = `a merge of ${counted(cs.resolving.commits, 'commit')}, its conflicts resolved`
        const { untracked, also } = concluded
        const lines = [
          `Resolved: ${cs.resolving.paths.join(', ')}`,
          ...(also.length ? [`Also changed: ${also.join(', ')}`] : []),
          ...(untracked.length ? [`Left out, untracked: ${untracked.join(', ')}`] : []),
        ]
        await refuseSymlinks(dir, [`${WORK_DIR}/out/${outputFile.push}`])
        await prependSection(join(dir, WORK_DIR, 'out', outputFile.push), lines.join('\n\n'), false)
      }
    }
    const modelFull =
      worker.status === 'stopped: quota' &&
      modelFor(unit.rule.model, id, 1) !== model &&
      !!modelOver(allowances[id] ?? a, model)
    if ((worker.status === 'failed' || modelFull) && saved && !input.signal?.aborted) {
      const out = join(unitDir, 'out')
      const keep = () => {
        cs.verdict = result.verdict ?? cs.verdict
        if (report) {
          reports.push({ id: unit.id, skill: unit.skill, text: report, out })
          result.reported = true
        }
        cs.previous = { skill: unit.skill, out }
      }
      cs.retrying = { result, start, saved, keep }
      return
    }
    cs.verdict = result.verdict ?? cs.verdict
    if (report) {
      reports.push({ id: unit.id, skill: unit.skill, text: report, out: join(unitDir, 'out') })
      result.reported = true
    }
    // What the next step works from: a committing step's commits, a report step's report.
    const left = reportsOnly(unit.deliver) ? report !== '' : commits > 0 || !!cs.merged
    if (worker.status === 'stopped: aborted' || input.signal?.aborted) {
      cs.interrupted = true
      cs.ended = { reason: 'interrupted' }
    } else if (worker.status !== 'done') cs.ended = { reason: `${unit.id} ${worker.status}` }
    else if (asks) {
      cs.ended = { reason: `${unit.id} asked questions`, passedOver: true }
      cs.asked = { step: unit.id, text: questions }
      if (status === 'ask') cs.leaves = leave(run, cs, 'ask')
    } else if (status === 'continue' && kept) {
      cs.leaves = leave(run, cs, 'continue')
      cs.ended = {
        reason: `${unit.id} ${cs.leaves.byHand ? 'said' : 'will'} continue`,
        passedOver: true,
      }
    } else if (!left) {
      const reason = `${unit.id} ${reportsOnly(unit.deliver) ? 'wrote no report' : 'committed nothing'}`
      // Inside a loop it ends only the loop, and the steps after it still run.
      if (loop) loop.ended = reason
      else cs.ended = { reason, passedOver: true }
    } else if (loop && p.loop) {
      if (result.verdict) loop.verdict = result.verdict
      const logFile = join(dir, WORK_DIR, 'out', 'check.log')
      const until = await factsFor(p.loop.until, unit, dir, cs.since, loop.verdict, log, logFile, {
        from: cs.from,
        published: true,
      })
      if (until.check) loop.check = until.check
      if (until.check?.stopped || until.check?.refused)
        loop.ended = `until ${describeCondition(p.loop.until)} not checked: ${until.check.failed}`
      else if (untilHolds(p.loop.until, until.facts)) {
        loop.held = true
        loop.ended = `until held: ${describeCondition(p.loop.until)}`
      } else if (isLast(p.loop)) loop.ended = maxReached(p.loop.max)
    }
    if (loop && cs.ended) loop.ended ??= cs.ended.reason
  } catch (e) {
    Object.assign(result, { status: 'error', reason: (e as Error).message })
    log(`error: ${(e as Error).stack}`)
    cs.ended = { reason: `${unit.id} error: ${(e as Error).message}` }
    if (loop) loop.ended ??= cs.ended.reason
  } finally {
    await new Promise((done) => logFile.end(done))
    const lost = lostToWorker(dir)
    // Before a first step's workspace is prepared, the clone's `.away` may be the branch's.
    if (cs.cloned !== undefined && !lost) await copyStep(dir, unitDir)
    if (start && !lost)
      try {
        await restoreGit(dir)
        // Only matters after a throw; the run's own call already ran otherwise.
        const lines = (await provider.finish?.(dir)) ?? []
        const stamp = new Date().toISOString()
        await appendFile(
          join(unitDir, 'worker.log'),
          lines.map((line) => `${stamp} ${line}\n`).join(''),
        )
        await handOff(dir, start, unitDir)
        if (!cs.retrying) cs.previous = { skill: unit.skill, out: join(unitDir, 'out') }
      } catch (e) {
        input.ctx.log(`${unit.id}: hand-off error: ${bounded((e as Error).stack ?? '')}`)
        await appendFile(
          join(unitDir, 'worker.log'),
          `${new Date().toISOString()} hand-off error: ${(e as Error).stack}\n`,
        ).catch(() => {})
        cs.retrying?.keep()
        cs.retrying = undefined
        cs.ended ??= { reason: `${unit.id} error: ${(e as Error).message}` }
        if (loop) loop.ended ??= cs.ended.reason
      }
    if (!input.dryRun) await rm(plugin, { recursive: true, force: true })
  }
  event(`${unit.id}: ${result.status}`)
}
