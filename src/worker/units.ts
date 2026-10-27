import { createWriteStream, existsSync } from 'node:fs'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join, posix } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import type { Config } from '../config/schema.js'
import type { Attempts } from '../core/attempts.js'
import { MAX_TURNS, quotaFacts, route, withQuota } from '../core/budget.js'
import { describeCondition, holds } from '../core/condition.js'
import { planComment, questionsComment, resultComment, type Status } from '../core/footer.js'
import {
  bySlice,
  describeChain,
  isNamed,
  modelFor,
  type PlannedUnit,
  type RunPlan,
  slug,
  taskChain,
} from '../core/foreman.js'
import {
  CONTAINER_HOME,
  contain,
  contained,
  gitUnrestored,
  isolated,
  lostToWorker,
  workerHome,
  workerRoot,
} from '../core/launch.js'
import {
  checkPlan,
  contractName,
  contractText,
  elsewhere,
  latestResult,
  planYaml,
} from '../core/plan.js'
import {
  type Commented,
  type Moved,
  type PlanPost,
  type Posted,
  type Questions,
  type RunReport,
  type StepFiles,
  summaryOf,
  type UnitResult,
} from '../core/report.js'
import type {
  Ctx,
  Deliver,
  Forge,
  Item,
  McpServer,
  Provider,
  Quota,
  Source,
  Unit,
} from '../core/types.js'
import { unwritable, writeItem } from '../sources/index.js'
import { commitsSince, createChecks, git, head, untilHolds } from './checks.js'
import { fetchContexts } from './context.js'
import { notifyUnit } from './notify.js'
import type { Outcome, Stack } from './publish.js'
import type { ReplayState } from './replay.js'
import { runWorker, type WorkerOptions } from './run.js'
import { maskSecrets, runSetup } from './setup.js'
import {
  cutBranch,
  describeLoop,
  freeBranch,
  type Held,
  type OpenLoop,
  type Publisher,
  publishSlice,
  type StepReport,
} from './slices.js'
import {
  discard,
  handOff,
  isLast,
  made,
  maxReached,
  readStatus,
  readVerdict,
  type Snapshot,
  setupEnv,
  snapshot,
} from './steps.js'
import { shortage } from './watchdog.js'
import {
  configSecrets,
  copyOut,
  gateEnv,
  notSymlink,
  outputFile,
  type Previous,
  prepareWorkspace,
  readOutput,
  refuseSymlinks,
  reportsOnly,
  type Shipped,
  WORK_DIR,
  workerEnv,
  writeOutput,
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
  /** Logs a unit's start and end, and what went wrong; `ctx.log` when unset. */
  event?: (line: string) => void
  signal?: AbortSignal
  watch?: WorkerOptions['watch']
  /** Why the machine is too short on memory or disk at a clone's dir to start a unit. */
  shortage?: (dir: string) => Promise<string | undefined>
  skillDirs?: { user: string; builtin: string }
  /** Earlier attempts: a chain's first step on an item gets the item's latest report. */
  attempts?: Attempts
  /** Runs each chain when it's this run's turn: awaywork watch runs one worker at a time across its runs. */
  turn?: <T>(chain: () => Promise<T>) => Promise<T>
  /** A `run: soon` run: no notify for a step that sat out or its `when` passed over, as the next poll tries it again. */
  soon?: boolean
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

/** A step that sat out or its `when` passed over: a poll tries it again an hour later. */
const triedLater = (r: UnitResult) =>
  r.status === 'skipped' &&
  (!!r.reason?.startsWith('no provider left') ||
    (!!r.passedOver && !!r.reason?.startsWith('when ')))

/** Where a chain's slice keeps what it published: `out/`, `out-2/` and so on. */
const sliceOut = (at: number) => (at > 0 ? `out-${at + 1}` : 'out')

/** Why a `deliver: pr` slice opens as a draft: a step that failed, stopped or never ran; `runLine` splits at `; `. */
function notReady(r: UnitResult): string {
  const why = r.status === 'skipped' && r.reason?.split('\n')[0]?.split('; ')[0]
  return `${r.planned.unit.id} ${r.status}${why ? `: ${why}` : ''}`
}

/** A step's files, and what it concluded: its slice's PR body when it leads the slice, else its report. */
async function leftBy(
  runDir: string,
  chainId: string,
  r: UnitResult,
  deliver: Deliver,
  lead: boolean,
): Promise<Pick<UnitResult, 'files' | 'summary'>> {
  if (!r.step) return {}
  // Relative and with `/`: report.json is read on other machines, from an uploaded artifact.
  const step = posix.join('units', chainId, r.step)
  const slice = posix.join('units', chainId, sliceOut(r.planned.slice ?? 0))
  const all: StepFiles = {
    log: posix.join(step, 'worker.log'),
    report: posix.join(step, 'out', outputFile.report),
    diff: posix.join(step, 'out', 'diff.patch'),
    ...(lead && {
      sliceBody: posix.join(slice, outputFile[deliver]),
      sliceDiff: posix.join(slice, 'diff.patch'),
    }),
  }
  const files: StepFiles = Object.fromEntries(
    Object.entries(all).filter(([, f]) => existsSync(join(runDir, f))),
  )
  const read = async (f?: string) => (f ? readOutput(join(runDir, f)) : '')
  // Only a PR's body opens with its title.
  const summary =
    summaryOf(await read(files.sliceBody), deliver === 'draft_pr' || deliver === 'pr') ||
    summaryOf(await read(files.report))
  return { files, ...(summary && { summary }) }
}

/** Under every tracker's comment limit as text; Jira's write also checks the longer ADF it sends. */
const MAX_COMMENT_BYTES = 30_000

/** A slice's outcome that published: a PR, a push, a report or a pending review left. */
const delivered = (o: Outcome | undefined) =>
  !!o && o.kind !== 'none' && !(o.kind === 'report' && o.unposted)

/** A finished chain's result: each slice's report, or a line linking what it published. */
const resultOf = (outcomes: Outcome[]): string =>
  outcomes
    .map((o) => {
      if (o.kind === 'report') return o.text
      if (o.kind === 'pr') return `Opened ${o.url}${o.ready ? '' : ' as a draft'}`
      if (o.kind === 'pushed')
        return `Pushed ${o.commits} ${o.commits === 1 ? 'commit' : 'commits'} onto ${o.url}`
      if (o.kind === 'review') return `Left your pending review on ${o.url}`
      return ''
    })
    .filter(Boolean)
    .join('\n\n')

/** A failed step to retry: the clone as it found it, and what it leaves the chain if the retry can't start. */
interface Retry {
  result: UnitResult
  start: string
  saved: Snapshot
  keep: () => void
}

/** A task's chain skipped, its loops' first rounds listed, e.g. because a task it waits on opened no PR, or never got to run. */
function skipTask(chain: PlannedUnit[], reason: string): UnitResult[] {
  return chain
    .filter((p) => !p.loop || p.loop.round === 1)
    .map((planned) => ({ planned, status: 'skipped', reason }))
}

/** The chains `name` names by a unit id or an item, in any case: each chain's first step. */
export function namedChains(plan: RunPlan, name: string): PlannedUnit[] {
  const heads = plan.units
    .filter((p) => p.unit.id === name.toLowerCase() || p.unit.items.some((i) => isNamed(i, name)))
    .map((p) => p.chain ?? p.unit.id)
  return plan.units.filter((p) => !p.chain && heads.includes(p.unit.id))
}

/**
 * Runs the plan's chains one at a time, re-routing as windows fill. A rule's steps all work in one
 * clone, and each slice of the chain publishes once, when it ends: its commits as a PR or a
 * push onto your PR, else its reports. A PR stacks on the awaywork PR a rule took up, or on
 * the slice before, whose pushed tip the next slice's commits are published onto.
 * Every step leaves `units/<id>/<n>-<skill>/` in the run dir: its context, prompt, output and worker
 * log; what each slice published is in `units/<id>/out/`, `out-2/` and so on.
 */
export async function runUnits(input: RunInput): Promise<RunReport> {
  const startedAt = new Date()
  const allowances = { ...input.plan.allowances }
  const routed: Record<string, number> = {}
  const quotas: Record<string, Quota> = {}
  const event = (line: string) => (input.event ?? input.ctx.log)(line)
  const results: UnitResult[] = []
  const named = input.only ? namedChains(input.plan, input.only) : []
  if (input.only && named.length !== 1)
    throw new Error(`"${input.only}" names ${named.length} units in this run's plan, not one`)
  // A step needs its whole chain.
  const chains = input.plan.units
    .filter((p) => !p.chain && (!input.only || named.includes(p)))
    .map((head) => [head, ...input.plan.units.filter((p) => p.chain === head.unit.id)])
  const secrets = configSecrets(input.config, input.providers, input.sources)
  // The worker user can't reach the run dir: its plugins and each clone get a folder of their own under /tmp.
  const root = isolated() ? await workerRoot() : input.runDir

  const { check, factsFor, restoreGit, rememberGitConfig, baseline } = createChecks({
    env: input.ctx.env,
    secrets,
    signal: input.signal,
    until: input.until,
  })
  const publisher: Omit<Publisher, 'judge'> = {
    forge: input.forge,
    runId: input.runId,
    signal: input.signal,
    check,
  }

  /** Posts a finished unit's result on each of its items that is yours; a write that fails is reported, never thrown. */
  const postResult = async (
    p: PlannedUnit,
    text: string,
    status: Status = 'done',
    continued = 0,
  ): Promise<Commented[]> => {
    const posted: Commented[] = []
    for (const item of ownItems(p)) {
      const source = input.sources[item.source]
      const refused = unwritable(item, source)
      if (refused) {
        input.ctx.log(`${item.key} got no result, ${refused}`)
        continue
      }
      const ref = { item: `${item.source}:${item.key}` }
      if (Buffer.byteLength(text) > MAX_COMMENT_BYTES) {
        posted.push({ ...ref, failed: `the result is over ${MAX_COMMENT_BYTES} bytes` })
        continue
      }
      try {
        const write = {
          op: 'comment',
          body: resultComment(text, status, p.unit.skill, item.task?.id, continued),
        } as const
        const cfg = input.config.sources[item.source]
        const { updated, url = item.url } = await writeItem(source, cfg, item, write, input.ctx)
        input.ctx.log(`${item.key}: result posted on ${url}`)
        posted.push({ ...ref, url, ...(updated && { updated }) })
      } catch (e) {
        const failed = maskSecrets((e as Error).message, secrets, input.ctx.env)
        event(`couldn't post the result on ${item.key}: ${failed}`)
        posted.push({ ...ref, failed })
      }
    }
    return posted
  }

  /** Moves each of a finished unit's items that is yours to `to`, after its result was `posted`; a write that fails is reported, never thrown. */
  const moveItems = async (
    items: Item[],
    to: string,
    posted: Commented[] = [],
  ): Promise<Moved[]> => {
    const moved: Moved[] = []
    for (const item of items) {
      const source = input.sources[item.source]
      const refused = unwritable(item, source)
      if (refused) {
        input.ctx.log(`on_done: ${item.key} not moved, ${refused}`)
        continue
      }
      const ref = { item: `${item.source}:${item.key}`, to }
      // The result's post is awaywork's own change: the move compares with the item as it left it.
      const after = posted.find((c) => c.item === ref.item)?.updated
      const read = after ? { ...item, fields: { ...item.fields, updated: after } } : item
      try {
        const write = { op: 'move', to } as const
        const cfg = input.config.sources[item.source]
        const { updated } = await writeItem(source, cfg, read, write, input.ctx)
        input.ctx.log(`on_done: moved ${item.key} to ${to}`)
        moved.push({ ...ref, ...(updated && { updated }) })
      } catch (e) {
        const failed = maskSecrets((e as Error).message, secrets, input.ctx.env)
        event(`on_done: couldn't move ${item.key} to ${to}: ${failed}`)
        moved.push({ ...ref, failed })
      }
    }
    return moved
  }

  /** The latest report an earlier run left on the unit: from this machine's runs, else as its draft's body or its `continue` result on the item has it. */
  const lastReport = async (unit: Unit, chainDir: string): Promise<Previous | undefined> => {
    const runs = dirname(input.runDir)
    const kept = await earlierReport(unit.items, input.attempts ?? {}, runs, input.runId)
    const { resume } = unit
    if (kept || (!resume && !unit.continued)) return kept
    const item = unit.items[0] as Item
    const text = resume
      ? await input.forge.prsOn(unit.repo, unit.base).then(
          (prs) => prs.find((pr) => pr.number === resume.number)?.body,
          (e: Error) => input.ctx.log(`${unit.id}: couldn't read ${resume.url}: ${e.message}`),
        )
      : latestResult(item)?.text
    if (!text?.trim()) return undefined
    const out = join(chainDir, 'earlier')
    await mkdir(out, { recursive: true })
    await writeOutput(join(out, outputFile.report), `${text.trim()}\n`)
    return { skill: unit.skill, out, left: resume?.url ?? item.url }
  }

  /** A unit's items in one tracker's words: from the source of the item its rule matched first. */
  const ownItems = (p: PlannedUnit): Item[] =>
    p.unit.items.filter((i) => i.source === p.unit.items[0]?.source)

  /**
   * Posts a comment on the first of the unit's own items that is yours, through a source that writes;
   * a post that fails is reported, never thrown. An item waiting for an answer made no unit.
   */
  const postComment = async (
    p: PlannedUnit,
    what: string,
    body: (item: Item) => string,
  ): Promise<Posted> => {
    if (input.signal?.aborted) return { unposted: 'interrupted' }
    const item = ownItems(p).find((i) => !unwritable(i, input.sources[i.source]))
    if (!item) {
      const top = p.unit.items[0] as Item
      return { unposted: `${top.key} ${unwritable(top, input.sources[top.source])}` }
    }
    const ref = `${item.source}:${item.key}`
    try {
      const write = { op: 'comment', body: body(item) } as const
      const cfg = input.config.sources[item.source]
      const { url = item.url } = await writeItem(
        input.sources[item.source],
        cfg,
        item,
        write,
        input.ctx,
      )
      input.ctx.log(`${p.unit.id}: ${what} posted on ${url}`)
      return { item: ref, url }
    } catch (e) {
      const failed = maskSecrets((e as Error).message, secrets, input.ctx.env)
      event(`${p.unit.id}: couldn't post its ${what} on ${item.key}: ${failed}`)
      return { item: ref, unposted: failed }
    }
  }

  const postQuestions = async (p: PlannedUnit, text: string) =>
    Buffer.byteLength(text) > MAX_COMMENT_BYTES
      ? { unposted: `questions.md is over ${MAX_COMMENT_BYTES} bytes` }
      : postComment(p, 'questions', (item) => questionsComment(text, item.task?.id))

  /** Checks the chain's `plan.yml` in its `out` folder and posts it with the report and its contract; a refused plan posts nothing. */
  const postPlan = async (p: PlannedUnit, report: string, out: string): Promise<PlanPost> => {
    const limits = p.unit.planLimits ?? { maxTasks: input.config.limits.plan_tasks }
    const yaml = await readOutput(join(out, 'plan.yml'))
    const file = checkPlan(yaml, limits)
    if ('problem' in file) return { unposted: `plan.yml: ${file.problem}` }
    const name = file.plan.contract && contractName(file.plan.contract)
    const text = name ? (await readOutput(join(out, name))).replace(/\r\n/g, '\n').trimEnd() : ''
    if (name && !text.trim())
      return { unposted: `plan.yml: contract ${file.plan.contract} is missing or empty` }
    const body = planComment(report, yaml, name ? { name, text } : undefined)
    // The plan an approve approves is the one the next run reads back, so it must be the file's.
    const read = checkPlan(planYaml(body), limits)
    if (!('plan' in read && isDeepStrictEqual(read.plan, file.plan)))
      return {
        unposted: `plan.yml doesn't read back from its comment: ${'problem' in read ? read.problem : 'it reads as another plan'}`,
      }
    if (name && contractText(body, name) !== text)
      return { unposted: `the contract ${name} doesn't read back from its comment` }
    const tasks = file.plan.tasks.map((t) => t.id)
    if (Buffer.byteLength(body) > MAX_COMMENT_BYTES)
      return { tasks, unposted: `the plan comment is over ${MAX_COMMENT_BYTES} bytes` }
    return { tasks, ...(await postComment(p, 'plan', () => body)) }
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
        const { id, skill, deliver, items, repo } = r.planned.unit
        const chainId = r.planned.chain ?? id
        const outDir = r.step && join(input.runDir, 'units', chainId, r.step, 'out')
        const out = outDir && join(outDir, outputFile[deliver])
        const failure = await notifyUnit(
          hook.command,
          {
            runId: input.runId,
            id,
            skill,
            status: r.status,
            items,
            repo,
            verdict: r.verdict,
            pr,
            report: out && existsSync(out) ? out : undefined,
            outDir: outDir && existsSync(outDir) ? outDir : undefined,
          },
          input.signal,
        )
        if (failure)
          event(`notify failed for ${id}: ${maskSecrets(failure, secrets, input.ctx.env)}`)
      }
    }
  }

  const runChain = async (chain: PlannedUnit[], shipped: Shipped[] = []): Promise<UnitResult[]> => {
    const done: UnitResult[] = []
    const first = chain[0] as PlannedUnit
    const { repo, base } = first.unit
    const deliver = chain.find((p) => p.unit.deliver !== 'report')?.unit.deliver ?? 'report'
    const opensPr = deliver === 'draft_pr' || deliver === 'pr'
    const { resume, continued: before = 0 } = first.unit
    // The awaywork PR whose branch the chain works on: one a rule took up, or the one a task stacks on.
    const pickedUp =
      first.unit.items
        .flatMap((i) => i.linkedPrs)
        .find((pr) => pr.ours && pr.repo === repo && pr.branch === base)?.url ??
      first.unit.stackedOn
    // The open slice's base, branch and the PR it stacks on: the awaywork PR the chain started on, or the slice before's; a draft it resumes stacks as it did.
    const shape = {
      base,
      branch: first.unit.branch,
      stackedOn: opensPr ? (resume ? first.unit.stackedOn : pickedUp) : undefined,
      resume,
    }
    // `changed` diffs from where the chain started, the awaywork PR it took up, else the default branch, as cloned.
    let since = ''
    const dir = isolated() ? await workerRoot(0o700) : join(root, 'work', first.unit.id)
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
    // What gates compare their scripts with: an awaywork PR's commits are a worker's, so where it left the default branch.
    let original: string | undefined
    // Where the open slice's commits start in the clone, and whether its branch is still to be cut there.
    let from: string | undefined
    let cut = false
    let previous: Previous | undefined
    let verdict: string | undefined
    let ran = false
    let interrupted = false
    // A step that failed, to run again on its provider's next model.
    let retrying: Retry | undefined
    // Why the steps left didn't run, whether they're passed over rather than missed, and whether a slice's `when` did.
    let ended: { reason: string; passedOver?: true; when?: true } | undefined
    // A slice that ran and didn't publish, had a step fail or a loop whose `until` never held: on_done doesn't run.
    let unfinished = false
    // The step that couldn't go on without answers, and its questions.
    let asked: Pick<Questions, 'step' | 'text'> | undefined
    // Whether that step's status file said `ask`: only then do its commits publish as asking.
    let saidAsk = false
    // A step said `continue`: the chain stops, publishes what it has and runs again later.
    let continues = false
    // A later slice asked or said `continue`, or a draft did where awaywork can't push onto it: no later run goes on, so it's yours to finish.
    let byHand: string | undefined
    // Each slice's first step, which publishes it.
    const leads = new Set<UnitResult>()

    /** Runs a gate's judge like a step, on the rule's providers and models, its worker log in the slice's `out/`. */
    const judge: Publisher['judge'] = async (gate, skill, unit, dir, from) => {
      // On a provider that ran a step of its slice, a judge rides on that step's fallback unit; elsewhere it takes one.
      const ranSlice = new Set(
        done
          .filter((r) => (r.planned.slice ?? 0) === at && r.status !== 'skipped')
          .map((r) => r.provider),
      )
      const counted = Object.fromEntries(Object.entries(routed).filter(([p]) => !ranSlice.has(p)))
      const { provider: id, passed } = route(unit.providers, allowances, counted)
      const provider = id && input.providers[id]
      const a = id && allowances[id]
      if (!id || !provider || !a)
        return `no provider left: ${passed.join('; ') || 'none configured'}`
      if (!ranSlice.has(id)) routed[id] = (routed[id] ?? 0) + 1
      const image = input.config.repos[unit.repo]?.image
      const entry = input.config.providers.find((c) => c.id === id)
      const model = modelFor(unit.rule.model, id, 0) ?? entry?.model
      const name = `judge-${gate}-${slug(skill)}`
      input.ctx.log(`${unit.id}: gate ${gate}, ${skill} on ${id}${model ? ` (${model})` : ''}`)
      const out = join(chainDir, sliceOut(at))
      await mkdir(out, { recursive: true })
      const logFile = createWriteStream(join(out, `${name}.log`))
      const log = (line: string) => logFile.write(`${new Date().toISOString()} ${line}\n`)
      const plugin = join(root, 'plugins', `${unit.id}-${name}`)
      const judged: Unit = {
        ...unit,
        skill,
        skills: [],
        deliver: 'report',
        foreign: true,
        stackedOn: undefined,
        rule: {
          ...unit.rule,
          instructions: [],
          with: undefined,
          when: undefined,
        },
      }
      let why: string | undefined
      try {
        if (contained() && image) contain(dir, { image, plugin, secrets })
        const prompt = await prepareWorkspace({
          ...input,
          unit: judged,
          dir,
          plugin,
          provider,
          ctx: { ...input.ctx, log },
          reuse: true,
          judge: { from },
        })
        const withheld = secrets.filter((name) => !provider.secrets.includes(name))
        const job = {
          unit: judged,
          dir,
          prompt,
          maxTurns: a.kind === 'fallback' ? a.turns : MAX_TURNS,
          model,
          env: await gateEnv(input.ctx.env, dir, withheld, from, original),
          config: entry?.config,
          configDir: input.configDir,
          plugin,
        }
        const worker = await runWorker(provider, job, a, {
          log,
          signal: input.signal,
          until: input.until,
          maxMinutes: input.config.limits.unit_minutes,
          watch: input.watch,
        })
        if (worker.quota) {
          quotas[id] = worker.quota
          allowances[id] = withQuota(a, worker.quota)
        }
        if (worker.status !== 'done') why = worker.reason ?? 'its worker failed'
      } catch (e) {
        why = (e as Error).message
        log(`error: ${(e as Error).stack}`)
      } finally {
        await new Promise((done) => logFile.end(done))
        await rm(plugin, { recursive: true, force: true })
      }
      if (lostToWorker(dir)) throw new Error('the clone is lost to the worker user')
      await restoreGit(dir)
      return why
    }

    /** Publishes the open slice once its last step ended; after its PR, the next slice is cut at the clone's tip. */
    const endSlice = async (last: boolean) => {
      const lead = done.find(
        (r) => r.planned.unit.id === opening.unit.id && r.status !== 'skipped' && !r.retried,
      )
      const out = join(chainDir, sliceOut(at))
      // A step the chain ended before also leaves the slice unfinished; one passed over by its `when` doesn't.
      const failed = done.find(
        (r) =>
          (r.planned.slice ?? 0) === at &&
          !r.retried &&
          (/^(failed|stopped|error)/.test(r.status) || (r.status === 'skipped' && !r.passedOver)),
      )
      if (from !== undefined && lead && ran && !input.dryRun) {
        leads.add(lead)
        if (Object.keys(loops).length) lead.loop = Object.values(loops).map(describeLoop).join('; ')
        interrupted ||= !!input.signal?.aborted
        try {
          const kept = interrupted
            ? 'interrupted'
            : lostToWorker(dir)
              ? 'the clone is lost to the worker user'
              : gitUnrestored(dir)
                ? "the clone's .git was refused"
                : undefined
          const askedOn = ownItems(first).find((i) => !unwritable(i, input.sources[i.source]))
          // Only a first slice's draft goes on in a later run, and only where awaywork can push onto it.
          const byHandWhy =
            at > 0 && (asked || continues)
              ? "a stacked slice can't go on"
              : opensPr && !input.forge.canFastForward && (saidAsk || continues)
                ? 'awaywork goes on with its own draft on GitHub only'
                : undefined
          // Where awaywork can't push, the footer still records it, to hold dependents back.
          const held: Held | undefined =
            at > 0
              ? undefined
              : saidAsk
                ? { status: 'ask', continued: before, url: askedOn?.url }
                : continues
                  ? { status: 'continue', continued: before + 1 }
                  : undefined
          lead.outcome = kept
            ? { kind: 'none', reason: kept, unpublished: true }
            : await publishSlice(
                { ...publisher, judge },
                { ...first.unit, ...shape, deliver },
                dir,
                from,
                original ?? from,
                reports,
                loops,
                stack,
                // Only the whole chain, cut from the default branch as the draft it resumes was, closes its issues.
                last && !first.capped && (base === '' || (!!shape.resume && !shape.stackedOn)),
                (failed && notReady(failed)) || byHandWhy,
                held,
              )
          // A stacked slice's questions stay in the report whatever it published; a first slice's only with a draft.
          if (byHandWhy && (at > 0 || lead.outcome.kind === 'pr'))
            byHand = `${byHandWhy}: finish ${lead.outcome.kind === 'pr' ? lead.outcome.url : `it on ${shape.stackedOn}`} by hand`
          if (asked && lead.outcome.kind === 'none' && !lead.outcome.unpublished)
            lead.outcome = { kind: 'none', reason: 'asked questions' }
        } catch (e) {
          Object.assign(lead, { status: 'error', reason: (e as Error).message })
        } finally {
          if (!lostToWorker(dir)) await copyOut(join(dir, WORK_DIR, 'out'), out).catch(() => {})
        }
      }
      if (lead && (failed || !delivered(lead.outcome) || Object.values(loops).some((l) => !l.held)))
        unfinished = true
      if (last || ended) return
      const outcome = lead?.outcome
      if (outcome?.kind === 'pr') {
        if (stack) stack.onto = outcome.head
        shape.stackedOn = outcome.url
        if (previous)
          previous.published = { url: outcome.url, body: join(out, outputFile.draft_pr) }
      } else if (!input.dryRun) {
        ended = { reason: `${opening.unit.id} opened no PR to stack on`, passedOver: true }
        return
      }
      published.add(shape.branch)
      shape.base = shape.branch
      shape.resume = undefined
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

    for (let i = 0; i < chain.length; i += retrying ? 0 : 1) {
      const p = chain[i] as PlannedUnit
      const retryOf = retrying
      retrying = undefined
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
        // A retry that can't start leaves the failed attempt standing, as without a model list.
        if (retryOf) {
          retryOf.result.reason ??= `not retried: ${reason}`
          retryOf.keep()
          reason = `${p.unit.id} failed, not retried: ${reason}`
        } else skip(reason)
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
      const short = await (input.shortage ?? shortage)(dir)
      if (short) {
        end(short)
        continue
      }
      const image = input.config.repos[p.unit.repo]?.image
      if (contained() && !image) {
        end(`no image for ${p.unit.repo}: isolation: container needs one in its repos entry`)
        continue
      }
      const unit = { ...p.unit, ...shape }
      const candidates = retryOf ? [retryOf.result.provider as string] : unit.providers
      const { provider: id, passed } = route(candidates, allowances, routed)
      const provider = id && input.providers[id]
      if (!id || !provider) {
        end(`no provider left: ${passed.join('; ') || 'none configured'}`)
        continue
      }
      // A resumed draft's branch is the unit's own: no other name to find.
      if ((cloned === undefined || cut) && opensPr && !shape.resume) {
        const named = p.unit.branch
        const free = await freeBranch(input.forge, p.unit, published).catch((e: Error) => ({
          skip: `couldn't check ${named} on ${unit.repo}: ${e.message}`,
        }))
        if ('skip' in free) {
          end(free.skip)
          continue
        }
        if (free.taken)
          input.ctx.log(`${unit.id}: ${free.taken} is taken on ${unit.repo}, using ${free.branch}`)
        shape.branch = unit.branch = free.branch
      }
      routed[id] = (routed[id] ?? 0) + 1
      if (retryOf) retryOf.result.retried = true
      const entry = input.config.providers.find((c) => c.id === id)
      const model = modelFor(unit.rule.model, id, retryOf ? 1 : 0) ?? entry?.model
      const starts = `${unit.id}: ${unit.skill} on ${id}${model ? ` (${model})` : ''}`
      // A unit its `when` may pass over says it starts only once that held.
      const gated = !!unit.rule.when && !retryOf && !input.dryRun
      if (!gated) event(starts)

      const step = `${done.filter((r) => r.step).length + 1}-${slug(unit.skill)}`
      const unitDir = join(chainDir, step)
      const plugin = join(root, 'plugins', unit.id)
      if (contained() && image) contain(dir, { image, plugin, secrets })
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
        const whenLog = join(dir, WORK_DIR, 'context', 'previous', 'when.log')
        // A retry skips its `when`, which held on this same clone, and keeps the check's output.
        const checked = retryOf && (await readOutput(whenLog))
        if (retryOf) await discard(dir, retryOf.start, retryOf.saved)
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
          // A retried first step gets the earlier report again: setting up the clone wiped it.
          previous: previous ?? (reuse && !retryOf ? undefined : await lastReport(unit, chainDir)),
          reuse,
          shipped,
          chain: steps,
          slice: slices > 1 ? { n: at + 1, of: slices } : undefined,
          loop: p.loop,
        })
        if (checked) {
          await mkdir(dirname(whenLog), { recursive: true })
          await writeOutput(whenLog, checked)
        }
        if (!reuse) {
          // Before setup or any worker touched the clone: the chain's commits are the ones after it.
          cloned = from = await head(dir)
          if (chain.some((c) => c.unit.rule.when?.changed || c.loop?.until.changed))
            since = await git(dir, 'rev-parse', `origin/${pickedUp ? base : 'HEAD'}`)
          original =
            resume?.from ??
            (pickedUp && unit.gates ? await git(dir, 'merge-base', 'origin/HEAD', 'HEAD') : cloned)
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
            event(`${unit.id}: skipped, ${failed.split('\n')[0]}`)
            ended = { reason: `${unit.id} setup failed` }
            continue
          }
          await restoreGit(dir)
        }
        if (!reuse) await baseline(dir)
        const { when } = unit.rule
        if (when && !retryOf) {
          const met = await factsFor(when, unit, dir, since, verdict, log, whenLog, { from })
          Object.assign(met.facts, quotaFacts(a))
          // A check stopped or timed out before it exited says nothing: the chain ends without passing over it.
          if (met.check?.stopped || met.check?.timedOut) {
            const reason = `when ${describeCondition(when)} not checked: ${met.check.failed}`
            Object.assign(result, { status: 'skipped', reason })
            event(`${unit.id}: skipped, ${reason}`)
            routed[id] = (routed[id] ?? 1) - 1
            ended = { reason }
            interrupted ||= !!input.signal?.aborted
            continue
          }
          if (!holds(when, met.facts)) {
            const failed = met.check?.failed ? ` (${met.check.failed})` : ''
            const reason = `when ${describeCondition(when)} didn't hold${failed}`
            Object.assign(result, { status: 'skipped', reason, passedOver: true })
            event(`${unit.id}: skipped, ${reason}`)
            routed[id] = (routed[id] ?? 1) - 1
            // A rule's own `when` gates its whole chain, and a stacked step's the rest of it.
            if (p === opening) ended = { reason, passedOver: true, when: true }
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
        if (gated) event(starts)
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
        const retryable =
          !retryOf && published.size === 0 && modelFor(unit.rule.model, id, 1) !== undefined
        const saved = retryable ? await snapshot(dir) : undefined
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
              (!!shape.resume || (from !== undefined && (await commitsSince(dir, from)) > 0))
        if (status === 'continue' && !kept)
          input.ctx.log(
            `${unit.id}: status continue with ${opensPr || deliver === 'report' ? 'nothing to go on from' : `deliver ${deliver}`}, read as none`,
          )
        // Unless it says it asks, a step that committed went on: its questions aren't the chain's to ask.
        const asks = !!questions && (status === 'ask' || reportsOnly(unit.deliver) || commits === 0)
        result.made = made(commits, report, asks ? questions : '')
        if (worker.status === 'failed' && saved && !input.signal?.aborted) {
          const out = join(unitDir, 'out')
          const keep = () => {
            verdict = result.verdict ?? verdict
            if (report) {
              reports.push({ id: unit.id, skill: unit.skill, text: report, out })
              result.reported = true
            }
            previous = { skill: unit.skill, out }
          }
          retrying = { result, start, saved, keep }
          input.ctx.log(`${unit.id}: failed, retrying on the next ${id} model`)
          continue
        }
        verdict = result.verdict ?? verdict
        if (report) {
          reports.push({ id: unit.id, skill: unit.skill, text: report, out: join(unitDir, 'out') })
          result.reported = true
        }
        // What the next step works from: a committing step's commits, a report step's report.
        const left = reportsOnly(unit.deliver) ? report !== '' : commits > 0
        if (worker.status === 'stopped: aborted' || input.signal?.aborted) {
          interrupted = true
          ended = { reason: 'interrupted' }
        } else if (worker.status !== 'done') ended = { reason: `${unit.id} ${worker.status}` }
        else if (asks) {
          ended = { reason: `${unit.id} asked questions`, passedOver: true }
          asked = { step: unit.id, text: questions }
          saidAsk = status === 'ask'
        } else if (status === 'continue' && kept) {
          const why =
            at > 0
              ? 'said continue in a stacked slice'
              : opensPr && !input.forge.canFastForward
                ? 'said continue'
                : 'will continue'
          ended = { reason: `${unit.id} ${why}`, passedOver: true }
          continues = true
        } else if (!left) {
          const reason = `${unit.id} ${reportsOnly(unit.deliver) ? 'wrote no report' : 'committed nothing'}`
          // Inside a loop it ends only the loop, and the steps after it still run; a stacked slice's first step leaves it nothing.
          if (loop && !(at > 0 && p === opening)) loop.ended = reason
          else ended = { reason, passedOver: true }
        } else if (loop && p.loop) {
          if (result.verdict) loop.verdict = result.verdict
          const logFile = join(dir, WORK_DIR, 'out', 'check.log')
          const until = await factsFor(p.loop.until, unit, dir, since, loop.verdict, log, logFile, {
            from,
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
        if (loop && ended) loop.ended ??= ended.reason
      } catch (e) {
        Object.assign(result, { status: 'error', reason: (e as Error).message })
        log(`error: ${(e as Error).stack}`)
        ended = { reason: `${unit.id} error: ${(e as Error).message}` }
        if (loop) loop.ended ??= ended.reason
      } finally {
        await new Promise((done) => logFile.end(done))
        const lost = lostToWorker(dir)
        // Before a first step's workspace is prepared, the clone's `.away` may be the branch's.
        if (cloned !== undefined && !lost)
          await copyOut(join(dir, WORK_DIR), unitDir, {
            // The unit dir's replay.json and worker.log are awaywork's: the clone's never replace them.
            force: false,
            filter: async (src) =>
              ![
                join(dir, WORK_DIR, 'gh'),
                join(dir, WORK_DIR, 'twg'),
                join(dir, CONTAINER_HOME),
              ].includes(src) && (await notSymlink(src)),
          }).catch(() => {})
        if (start && !lost)
          try {
            await restoreGit(dir)
            await handOff(dir, start, unitDir)
            if (!retrying) previous = { skill: unit.skill, out: join(unitDir, 'out') }
          } catch (e) {
            retrying?.keep()
            retrying = undefined
            ended ??= { reason: `${unit.id} error: ${(e as Error).message}` }
            if (loop) loop.ended ??= ended.reason
          }
        if (!input.dryRun) await rm(plugin, { recursive: true, force: true })
      }
      event(`${unit.id}: ${result.status}`)
    }

    await endSlice(true)
    const onDone = input.plan.queue[first.rule]?.on_done
    const lead = done.find((r) => !r.planned.chain && !r.retried)
    // Answers to a stacked slice, or to a draft awaywork can't push onto, would reach no later run.
    if (asked && lead)
      lead.questions = {
        ...asked,
        ...(byHand ? { unposted: byHand } : await postQuestions(first, asked.text)),
      }
    else if (byHand && lead) lead.byHand = byHand
    if (deliver === 'plan' && !asked && lead?.outcome?.kind === 'report')
      lead.plan = await postPlan(first, lead.outcome.text, join(chainDir, sliceOut(0)))
    // Every slice that ran published, and only a `when` or a `continue` ended the chain early; a plan rule's plan was posted.
    const finished =
      !interrupted &&
      !unfinished &&
      (!ended || ended.when || (continues && !byHand)) &&
      leads.size > 0
    const posted = deliver !== 'plan' || !!lead?.plan?.url
    if (lead && finished && posted && !input.dryRun && !input.signal?.aborted) {
      // A report task's result is how its card hears it's done, so it always posts one.
      const reports =
        onDone?.comment === 'result' || (first.unit.items[0]?.task && reportsOnly(deliver))
      // A unit that goes on isn't done: a report keeps its count in its result, a PR in its draft.
      if (reports && (!continues || deliver === 'report')) {
        const outcomes = [...leads].flatMap((r) => r.outcome ?? [])
        lead.result = continues
          ? await postResult(first, resultOf(outcomes), 'continue', before + 1)
          : await postResult(first, resultOf(outcomes))
      }
      if (onDone?.move && !continues)
        lead.moved = await moveItems(ownItems(first), onDone.move, lead.result)
    }
    for (const r of done) {
      // A committing slice that committed nothing published its reports.
      const published = leads.has(r) && r.outcome?.kind === 'report' ? 'report' : deliver
      Object.assign(r, await leftBy(input.runDir, first.unit.id, r, published, leads.has(r)))
    }
    for (const path of [dir, workerHome(dir)])
      if (path && !input.dryRun && !lostToWorker(path))
        await rm(path, { recursive: true, force: true })
    if (stack) await rm(stack.repo, { recursive: true, force: true })
    return done
  }

  // The PR each chain opened first, the chains a step ran in, and those whose draft waits for a later run, by id: a task's chain stacks on its dependency's.
  const opened: Record<string, { repo: string; branch: string; url: string; head: string }> = {}
  const started = new Set<string>()
  const held = new Map<string, Held['status']>()

  /** Why a task's chain can't start: a task it stacks on or waits for opened no PR in this run; else the files its tasks in other repos ship, from their PRs. */
  const blocked = async (head: PlannedUnit): Promise<{ skip: string } | { shipped: Shipped[] }> => {
    const item = head.unit.items[0] as Item
    const task = item.task
    const own = task?.plan.find((t) => t.id === task.id)
    if (!task || !own) return { shipped: [] }
    const chainOf = (id: string) => taskChain(input.plan.units, item, id)?.unit.id ?? ''
    const waited = [
      ...(head.after && task.onto ? [{ id: task.onto, chain: head.after }] : []),
      ...(head.waitsFor ?? []).map((id) => ({ id, chain: chainOf(id) })),
    ]
    const missing = input.dryRun ? undefined : waited.find(({ chain }) => !opened[chain])
    if (missing)
      return {
        skip: `${missing.id} ${held.has(missing.chain) ? `left a draft that says ${held.get(missing.chain)}` : started.has(missing.chain) ? 'opened no PR' : "didn't run"}`,
      }
    const shipped: Shipped[] = []
    for (const dep of elsewhere(own, task.plan).filter((t) => t.ships?.length)) {
      const pr = task.parent.taskPrs?.[dep.id]
      const ran = opened[chainOf(dep.id)]
      // An open PR's branch is its head now; a merged one's may be deleted.
      const at = pr
        ? { repo: pr.repo, ref: pr.state === 'open' ? pr.branch : (pr.head ?? pr.branch) }
        : ran && { repo: ran.repo, ref: ran.head }
      if (!at) {
        input.ctx.log(
          `${head.unit.id}: prepared without ${dep.id}'s files; a real run reads them from its PR`,
        )
        continue
      }
      for (const path of dep.ships ?? []) {
        const text = await input.forge
          .fileAt(at.repo, at.ref, path)
          .catch((e: Error) => ({ failed: e.message }))
        if (text === undefined) return { skip: `${dep.id}'s PR has no ${path}` }
        if (typeof text !== 'string')
          return { skip: `couldn't read ${path} from ${dep.id}'s PR: ${text.failed}` }
        shipped.push({ task: dep.id, path, text })
      }
    }
    return { shipped }
  }

  try {
    const turn = input.turn ?? ((chain) => chain())
    for (const chain of chains) {
      const head = chain[0] as PlannedUnit
      const onto = head.after && opened[head.after]
      if (head.after && input.dryRun)
        input.ctx.log(
          `${head.unit.id}: prepared from the default branch; a real run clones ${head.unit.items[0]?.task?.onto}'s branch`,
        )
      const ready = await blocked(head)
      const done =
        'skip' in ready
          ? skipTask(chain, ready.skip)
          : await turn(() =>
              runChain(
                onto
                  ? chain.map((p) => ({
                      ...p,
                      unit: { ...p.unit, base: onto.branch, stackedOn: onto.url },
                    }))
                  : chain,
                ready.shipped,
              ),
            )
      if (done.some((r) => r.status !== 'skipped')) started.add(head.unit.id)
      const lead = done.find((r) => !r.planned.chain && !r.retried)
      // A draft that waits for a later run holds half-done work: nothing stacks on it.
      if (lead?.outcome?.kind === 'pr' && lead.outcome.held)
        held.set(head.unit.id, lead.outcome.held)
      else if (lead?.outcome?.kind === 'pr')
        opened[head.unit.id] = {
          repo: lead.planned.unit.repo,
          branch: lead.planned.unit.branch,
          url: lead.outcome.url,
          head: lead.outcome.head,
        }
      results.push(...done)
      await notifyUnits(done.filter((r) => !r.retried && !(input.soon && triedLater(r))))
    }
  } finally {
    if (root !== input.runDir && !input.dryRun && !lostToWorker(root))
      await rm(root, { recursive: true, force: true })
  }

  const { runId, dryRun, plan } = input
  return { runId, dryRun, startedAt, finishedAt: new Date(), plan, results, quotas }
}
