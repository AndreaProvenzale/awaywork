import { type Command, InvalidArgumentError, Option } from 'commander'
import { configPath, loadConfig } from '../config/load.js'
import { attemptsPath, skillsDirOf, skipsPath } from '../config/paths.js'
import type { Config } from '../config/schema.js'
import { loadSkills } from '../config/skills.js'
import { loadAttempts } from '../core/attempts.js'
import { type Allowance, allowance, pct } from '../core/budget.js'
import { taskBranches, taskPr } from '../core/fanout.js'
import { markComment, renderLink, threadClosed } from '../core/footer.js'
import { needsYou, planRun, type RunPlan } from '../core/foreman.js'
import { heldMove, withApproved } from '../core/posts.js'
import {
  DEFAULT_LOOKBACK,
  defaultRules,
  itemState,
  lookback,
  ruleThread,
  spanMs,
} from '../core/queue.js'
import { counted, type Moved } from '../core/report.js'
import { builtinSkills, type SkillCatalog } from '../core/skills.js'
import { activeSkips, loadSkips } from '../core/skips.js'
import type { Ctx, Forge, Item, Rule, Source } from '../core/types.js'
import { describeWindow, HOSTED_RUN_MINUTES, tooLongForHosted, windowEnd } from '../core/window.js'
import { forgeFor } from '../forge/index.js'
import { providerFor, providersOf } from '../providers/index.js'
import { sourceFor, threadHost, writeItem } from '../sources/index.js'
import { nextOccurrences, type RoutinesConfig } from '../sources/routines.js'
import { configSecrets } from '../worker/secrets.js'
import { maskSecrets } from '../worker/setup.js'
import { checkPins } from '../worker/store.js'
import { interactive, itemCommands, openScreen } from './browse.js'
import { reportConfigError } from './config-error.js'
import {
  ambiguous,
  clip,
  formatPlan,
  formatRules,
  formatSkipped,
  formatWhy,
  namedItems,
  planJson,
  rulesJson,
  warningLines,
} from './format.js'
import { linkThreads } from './threads.js'
import { type OnProgress, planTriage } from './triage.js'

export function planCommand(program: Command): void {
  program
    .command('plan')
    .description(
      "show the next run's units in order, with each provider's ceiling; runs no worker; browsable in a terminal",
    )
    .option('--json', 'print the plan, or with --rules the rules, and warnings as JSON')
    .option('--repo <glob>', 'only units in repos matching owner/name, * globs')
    .option('--rule <n>', 'only units of this queue rule, counted from 1', ruleNumber)
    .addOption(
      new Option(
        '--rules',
        'show what each rule takes now and what other rules take from it, instead of the units; probes no provider',
      ),
    )
    .addOption(
      new Option('--skipped [kind]', 'list the skipped items and why, or those of one kind')
        .choices(skipKinds)
        .conflicts(['json', 'rules']),
    )
    .addOption(
      new Option(
        '--why <key>',
        'say why an item is planned or skipped, by key, source:key or the ref plan shows',
      ).conflicts(['json', 'rules', 'skipped']),
    )
    .action(async (opts: PlanOptions) => {
      const browsing = interactive() && !opts.json && !opts.rules && !opts.skipped && !opts.why
      const screen = browsing ? openScreen('Planning the next run') : undefined
      try {
        const path = configPath(program.opts().config)
        const config = await loadConfig(path)
        if (opts.rules) return console.log(await describeRules(config, opts.json))
        const { plan, warnings } = await probeAndPlan(config, skillsDirOf(path), {
          ...opts,
          onProgress: screen?.progress,
        })
        const none =
          !plan.units.length && (opts.repo !== undefined || opts.rule !== undefined)
            ? 'no unit matches --repo/--rule'
            : undefined
        if (none && !screen) console.error(none)
        if (opts.skipped)
          return console.log(
            formatSkipped(plan.skipped, opts.skipped === true ? undefined : opts.skipped),
          )
        if (opts.why) {
          const [item, ...more] = namedItems(plan, opts.why)
          if (item && more.length === 0) return console.log(formatWhy(plan, item))
          console.error(
            item
              ? ambiguous(opts.why, [item, ...more])
              : `no item "${opts.why}" in this plan; awaywork plan --skipped lists them`,
          )
          process.exitCode = 1
          return
        }
        if (screen) {
          return await screen.browse(
            {
              ...planTriage(plan, warnings, process.stdout.rows, none),
              status: plan.skipped.length ? none : undefined,
            },
            itemCommands(async () => config),
          )
        }
        console.log(opts.json ? planJson(plan, warnings) : formatPlan(plan, warnings, true))
      } catch (e) {
        screen?.close()
        reportConfigError(e)
      }
    })
}

type PlanOptions = {
  json?: boolean
  rules?: boolean
  repo?: string
  rule?: number
  skipped?: string | true
  why?: string
}

/** What `--skipped` filters on. */
export const skipKinds = Object.keys(needsYou)

export function ruleNumber(text: string): number {
  const n = Number(text)
  if (!Number.isInteger(n) || n < 1) throw new InvalidArgumentError('a rule number from 1')
  return n
}

/**
 * Collects items from every configured source, probes every provider and plans a run started `at`,
 * masking secrets in warnings; `present` when it says, else when `at` is outside every window. `soon`
 * plans only the `run: soon` rules over its sources, and its units when it names them; `probe: false` leaves the providers out.
 * With `moves`, a run's, it first makes the moves on_done held on the posts you approved since, a dry run only saying them.
 */
export async function probeAndPlan(
  config: Config,
  userSkillsDir: string,
  opts: {
    /** A unit by name, which no cap, skip or attempt holds back. */
    unit?: string
    /** With `unit`: the skill of a one-off rule for the item it names, if no rule takes it. */
    skill?: string
    repo?: string
    rule?: number
    onProgress?: OnProgress
    at?: Date
    present?: boolean
    soon?: { sources: string[]; units?: string[] }
    probe?: boolean
    failed?: SourceFailed
    moves?: { dryRun: boolean; log: (line: string) => void }
    forge?: Forge
  } = {},
): Promise<{
  plan: RunPlan
  warnings: string[]
  ctx: Ctx
  sources: Record<string, Source>
  secrets: string[]
}> {
  const warnings: string[] = []
  const ctx: Ctx = { env: process.env, log: (line) => warnings.push(line) }

  const long =
    ctx.env.RUNNER_ENVIRONMENT === 'github-hosted' ? tooLongForHosted(config.windows) : []
  if (long.length)
    warnings.push(
      `GitHub-hosted runners end a job at 6 hours, so a run stops ${Math.floor(HOSTED_RUN_MINUTES / 60)}h${String(HOSTED_RUN_MINUTES % 60).padStart(2, '0')} after it starts, before ${long.map(describeWindow).join(', ')} ends`,
    )

  const { onProgress, soon, failed } = opts
  const sources = configuredSources(config)
  // A failed source's warning carries its stderr, and coding agents read `plan`.
  const secrets = configSecrets(config, providersOf(config), sources)
  const forge = opts.forge ?? forgeFor(config)
  const collected = await collectItems(config, ctx, {
    onProgress,
    sources: soon?.sources,
    failed,
    forge,
  })
  const { items, moved } = opts.moves
    ? await makeHeldMoves(collected, config, ctx, opts.moves, (line) =>
        maskSecrets(line, secrets, ctx.env),
      )
    : { items: collected, moved: [] }
  if (opts.moves) await closeThreads(items, config, forge, ctx, opts.moves)

  const at = opts.at ?? new Date()
  const present = opts.present ?? !windowEnd(config.windows, at)
  const allowances: Record<string, Allowance> = {}
  for (const p of opts.probe === false ? [] : config.providers) {
    const provider = providerFor(p.id, p.config)
    const name = `${p.id} quota`
    const unavailable = provider?.unavailable?.(ctx.env)
    if (unavailable) {
      warnings.push(`${p.id} unavailable: ${unavailable}`)
      onProgress?.({ name, state: 'failed', detail: `unavailable: ${unavailable}` })
      continue
    }
    onProgress?.({ name, state: 'running' })
    let reason: string | undefined
    const quota = await provider?.probe(ctx).catch((e: Error) => {
      reason = `probe failed: ${e.message}`
      return null
    })
    const a = allowance(p.budget, quota ?? null, at.getTime(), config.windows, { present, reason })
    allowances[p.id] = a
    onProgress?.(
      a.kind === 'quota'
        ? { name, state: 'done', detail: `${pct(a.used)} of ${pct(a.ceiling)}` }
        : { name, state: reason ? 'failed' : 'done', detail: firstLine(a.reason) },
    )
  }

  const skills = { user: await loadSkills(userSkillsDir), builtin: builtinSkills }
  await linkPlanTasks(items, config, skills, forge, ctx, onProgress)
  const attempts = await loadAttempts(attemptsPath)
  const skips = activeSkips(await loadSkips(skipsPath), Date.now())
  const planned = planRun({
    config,
    items,
    allowances,
    skills,
    attempts,
    skips,
    only: {
      repo: opts.repo,
      rule: opts.rule,
      soon: !!soon,
      units: soon?.units,
      named: opts.unit,
      skill: opts.skill,
    },
  })
  return {
    plan: {
      ...planned,
      skipped: planned.skipped.filter(
        (s) => s.kind !== 'no_rule' || !readForThread(s.item, planned.queue),
      ),
      present,
      ...(moved.length && { moved }),
      ...(config.sources.routines && {
        routines: nextOccurrences(config.sources.routines as RoutinesConfig, at),
      }),
    },
    warnings: warnings.map((w) => maskSecrets(w, secrets, ctx.env)),
    ctx,
    sources,
    secrets,
  }
}

/** The queue with what each rule takes now, as text or JSON; reads the sources, probes no provider. */
async function describeRules(config: Config, json = false): Promise<string> {
  const warnings: string[] = []
  const ctx: Ctx = { env: process.env, log: (line) => warnings.push(line) }
  const items = await collectItems(config, ctx)
  const secrets = configSecrets(config, providersOf(config), configuredSources(config))
  const masked = warnings.map((w) => maskSecrets(w, secrets, ctx.env))
  const rules = config.queue ?? defaultRules(Object.keys(config.sources))
  if (json) return rulesJson(rules, items, !config.queue, masked)
  return [
    ...warningLines(masked),
    config.queue ? 'Queue' : 'Queue (default: no queue in config)',
    ...formatRules(rules, items).map((line) => `  ${line}`),
  ].join('\n')
}

function configuredSources(config: Config): Record<string, Source> {
  return Object.fromEntries(
    Object.entries(config.sources).flatMap(([id, cfg]) => {
      const source = sourceFor(id, cfg)
      return source ? [[id, source]] : []
    }),
  )
}

/** Told of each source whose items couldn't be read. */
export type SourceFailed = (source: string, e: Error & { retryAfter?: number }) => void

/** Items from every configured source, or these `sources`, with their link lines, tasks linked to their PRs; a failing source is logged. */
export async function collectItems(
  config: Config,
  ctx: Ctx,
  opts: { onProgress?: OnProgress; sources?: string[]; failed?: SourceFailed; forge?: Forge } = {},
): Promise<Item[]> {
  const { onProgress, forge = forgeFor(config) } = opts
  const found: Item[] = []
  const queue = config.queue ?? defaultRules(Object.keys(config.sources))
  for (const [id, cfg] of Object.entries(config.sources)) {
    const source = sourceFor(id, cfg)
    if (!source || (opts.sources && !opts.sources.includes(id))) continue
    const link = source.link !== false && ((cfg as { link?: string }).link ?? source.link)
    onProgress?.({ name: id, state: 'running' })
    await source.items(cfg, ctx, finishedSince(queue, id)).then(
      (read) => {
        found.push(...read.map((i) => (link ? { ...i, link: renderLink(link, i) } : i)))
        onProgress?.({ name: id, state: 'done', detail: counted(read.length, 'item') })
      },
      (e: Error) => {
        ctx.log(`source ${id}: ${sourceFailure(e)}`)
        opts.failed?.(id, e)
        onProgress?.({ name: id, state: 'failed', detail: firstLine(e.message) })
      },
    )
  }
  await linkTasks(found, forge, ctx, onProgress)
  const items = await linkThreads(found, config, forge, ctx)
  // `approved` is read off the thread, an edited file in the store included.
  if (config.store) await checkPins(items, config.store, ctx.env)
  return items.map(withApproved)
}

const firstLine = (text: string) => text.split('\n')[0]

/** Makes each move on_done held on a post of yours you approved since, with no model run; a dry run only says it. Returns the items as moved, and the moves. */
async function makeHeldMoves(
  items: Item[],
  config: Config,
  ctx: Ctx,
  { dryRun, log }: { dryRun: boolean; log: (line: string) => void },
  mask: (line: string) => string,
): Promise<{ items: Item[]; moved: Moved[] }> {
  const out: Item[] = []
  const moved: Moved[] = []
  for (const item of items) {
    const to = item.mine && heldMove(item)
    if (!to || dryRun) {
      if (to) log(`on_done: would move ${item.key} to ${to}, its post approved`)
      out.push(item)
      continue
    }
    const cfg = config.sources[item.source]
    try {
      const write = { op: 'move', to } as const
      const { updated } = await writeItem(sourceFor(item.source, cfg), cfg, item, write, ctx)
      log(`on_done: moved ${item.key} to ${to}, its post approved`)
      moved.push({ item: `${item.source}:${item.key}`, to })
      // The move is awaywork's own change, not the card's.
      out.push(movedTo({ ...item, fields: { ...item.fields, ...(updated && { updated }) } }, to))
    } catch (e) {
      const failed = mask((e as Error).message)
      log(`on_done: couldn't move ${item.key} to ${to}: ${failed}`)
      moved.push({ item: `${item.source}:${item.key}`, to, failed })
      out.push(item)
    }
  }
  return { items: out, moved }
}

/** The item as a move to `to` leaves it, in the fields `where` reads too: a GitHub label, else the tracker's status or section. */
function movedTo(item: Item, to: string): Item {
  if (item.source === 'github')
    return {
      ...item,
      labels: [...item.labels, to],
      fields: { ...item.fields, label: [...item.labels, to] },
    }
  const swap = (v: unknown): unknown =>
    v === item.status ? to : Array.isArray(v) ? v.map(swap) : v
  const fields = { ...item.fields }
  for (const key of ['status', 'section']) if (key in fields) fields[key] = swap(fields[key])
  return { ...item, status: to, fields }
}

/** How far back the source's rules read finished items, the widest wins, a thread's card's for a week to close its thread; unset when none does. */
export function finishedSince(queue: Rule[], source: string): Date | undefined {
  const rules = rulesOf(queue, source)
  const reach = rules.flatMap((r) => lookback(r.where) ?? [])
  if (rules.some((r) => ruleThread(r))) reach.push(spanMs(DEFAULT_LOOKBACK))
  return reach.length > 0 ? new Date(Date.now() - Math.max(...reach)) : undefined
}

const rulesOf = (queue: Rule[], source: string) =>
  queue.filter((r) => !r.source || r.source === source)

/** A finished card read only so its thread can close: its source has a thread rule and no rule there looks back. */
function readForThread(item: Item, queue: Rule[]): boolean {
  const rules = rulesOf(queue, item.source)
  return (
    itemState(item) !== 'open' &&
    rules.some((r) => ruleThread(r)) &&
    rules.every((r) => lookback(r.where) === undefined)
  )
}

const FAILURE_LINE = 300

/** An error's first line and its stderr's last error line, else its last: a crashing script's whole stderr would bury the warning. */
export function sourceFailure(e: Error & { stderr?: unknown }): string {
  const [first = ''] = e.message.split('\n')
  const lines = (typeof e.stderr === 'string' ? e.stderr : '').split('\n').map((l) => l.trim())
  // Node ends a crash with its version, after the `Error: ...` line.
  const last =
    lines.findLast((line) => /^(\w*(error|exception)\b|fatal:)/i.test(line)) ??
    lines.findLast(Boolean)
  return (last ? [first, last] : [first]).map((line) => clip(line, FAILURE_LINE)).join('\n')
}

/** Each task an awaywork plan on a card names gets its PR, open, merged or closed: the one on its branch whose footer names it. */
export async function linkPlanTasks(
  items: Item[],
  config: Config,
  skills: SkillCatalog,
  forge: Forge,
  ctx: Ctx,
  onProgress?: OnProgress,
): Promise<void> {
  const queue = config.queue ?? defaultRules(Object.keys(config.sources))
  const tasks = taskBranches(items, config, queue, skills)
  const failed = new Set<Item>()
  for (const [i, task] of tasks.entries()) {
    onProgress?.({ name: 'reading task PRs', state: 'running', detail: `${i}/${tasks.length}` })
    task.card.taskPrs ??= {}
    const found = await forge
      .prsOn(task.repo, task.branch)
      .then(async (prs) => {
        const pr = taskPr(prs, task)
        if (pr?.state !== 'open' || !task.checks.length) return pr
        const all = await forge.checks(task.repo, pr.number)
        const named = task.checks.flatMap((name) => (all[name] ? [[name, all[name]]] : []))
        return { ...pr, checks: Object.fromEntries(named) }
      })
      .catch((e: Error) => {
        ctx.log(`reading ${task.key}'s PR on ${task.branch}: ${e.message}`)
        failed.add(task.card)
      })
    if (found) task.card.taskPrs[task.id] = found
  }
  // A card missing a task's PR can't tell which tasks still run, nor which ids are retired.
  for (const card of failed) card.taskPrs = null
  if (tasks.length)
    onProgress?.({
      name: 'reading task PRs',
      state: 'done',
      detail: `${tasks.length}/${tasks.length}`,
    })
}

/** Open tracker tasks link no PR natively, so the forge finds my PRs that name the task; a finished one links none. */
export async function linkTasks(
  items: Item[],
  forge: Forge,
  ctx: Ctx,
  onProgress?: OnProgress,
): Promise<void> {
  const tasks = items.filter(
    (i) => i.type === 'task' && itemState(i) === 'open' && i.linkedPrs.length === 0,
  )
  for (const [i, item] of tasks.entries()) {
    onProgress?.({ name: 'linking PRs', state: 'running', detail: `${i}/${tasks.length}` })
    item.linkedPrs = await forge.prsFor(item).catch((e: Error) => {
      ctx.log(`linking ${item.key} to PRs: ${e.message}`)
      return []
    })
  }
  if (tasks.length)
    onProgress?.({ name: 'linking PRs', state: 'done', detail: `${tasks.length}/${tasks.length}` })
}

/** Closes the thread of each card its source says is done, with a line saying so; a dry run only says it. */
async function closeThreads(
  items: Item[],
  config: Pick<Config, 'sources'>,
  forge: Forge,
  ctx: Ctx,
  { dryRun, log }: { dryRun: boolean; log: (line: string) => void },
): Promise<void> {
  for (const item of items) {
    const { thread } = item
    const state = itemState(item)
    if (!thread || state === 'open') continue
    const what = `${thread.url}, ${item.key}'s thread: the card is ${state}`
    if (dryRun) log(`would close ${what}`)
    else
      await threadHost(thread.host, config.sources, forge, ctx)
        ?.closeThread(thread, markComment(threadClosed))
        .then(
          () => log(`closed ${what}`),
          (e: Error) => ctx.log(`couldn't close ${thread.url}, ${item.key}'s thread: ${e.message}`),
        )
  }
}
