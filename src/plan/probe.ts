import { attemptsPath, skipsPath } from '#config/paths'
import type { Config } from '#config/schema'
import { readSetup } from '#config/skills'
import type { Where } from '#core/isolation/index'
import { hostedRunner, inAwayworkImage, WORKER } from '#core/isolation/sudo'
import { withholdsGrants } from '#core/trust'
import type { Ctx, Forge, Item, Provider, Rule, Source } from '#core/types'
import { forgeFor } from '#forge/index'
import { resolveTeams } from '#forge/teams'
import { clip } from '#format/terminal'
import { renderLink } from '#posts/footer'
import { withApproved } from '#posts/posts'
import { checkPins } from '#posts/store'
import { closeThreads, linkPlanTasks, linkTasks, linkThreads, makeHeldMoves } from '#posts/threads'
import { providerFor, providersOf } from '#providers/index'
import { shellRefusal } from '#providers/sandbox'
import { type Allowance, allowance, pct } from '#quota/budget'
import { describeWindow, HOSTED_RUN_MINUTES, tooLongForHosted, windowEnd } from '#quota/window'
import { sourceFor } from '#sources/index'
import { nextOccurrences, type RoutinesConfig } from '#sources/routines'
import { bounded, counted } from '#util/text'
import { configSecrets } from '#worker/clone/context'
import { maskSecrets } from '#worker/process/command'
import { loadAttempts } from './attempts'
import { type PlannedUnit, planRun, type RunPlan } from './foreman'
import { ruleThread } from './queue'
import { settingsFor } from './repos'
import { activeSkips, loadSkips } from './skips'
import { DEFAULT_LOOKBACK, itemState, lookback, spanMs } from './where'

/**
 * Collects items from every configured source, probes every provider and plans a run started `at`,
 * masking secrets in warnings; `present` when it says, else when `at` is outside every window. `soon`
 * plans only the `run: soon` rules over its sources, and its units when it names them; `probe: false` leaves the providers out.
 * With `moves`, a run's, it first makes the moves on_done held on the posts you approved since, a dry run only saying them.
 */
export async function probeAndPlan(
  given: Config,
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
  /** The config with its trusted teams resolved to logins. */
  config: Config
}> {
  const warnings: string[] = []
  const ctx: Ctx = { env: process.env, log: (line) => warnings.push(line) }
  const config = await resolveTeams(given, ctx.log)

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
  const probed: Record<string, Provider> = {}
  for (const p of opts.probe === false ? [] : config.providers) {
    const provider = providerFor(p.id, p.config)
    const name = `${p.id} quota`
    const unavailable = provider?.unavailable?.(ctx.env)
    if (unavailable) {
      warnings.push(`${p.id} unavailable: ${unavailable}`)
      onProgress?.({ name, state: 'failed', detail: `unavailable: ${unavailable}` })
      continue
    }
    const refused =
      config.isolation === 'none' &&
      !inAwayworkImage(process.env) &&
      provider &&
      (await shellRefusal(provider, {}, { untrusted: false }))
    if (refused) warnings.push(`${p.id}: its units are skipped: ${refused}`)
    if (provider) probed[p.id] = provider
    onProgress?.({ name, state: 'running' })
    let reason: string | undefined
    const quota = await provider?.probe(ctx).catch((e: Error) => {
      reason = `probe failed: ${bounded(e.message)}`
      return null
    })
    const a = allowance(config.budget, quota ?? null, at.getTime(), config.windows, {
      present,
      reason,
    })
    allowances[p.id] = a
    onProgress?.(
      a.kind === 'quota'
        ? { name, state: 'done', detail: `${pct(a.used)} of ${pct(a.ceiling)}` }
        : { name, state: reason ? 'failed' : 'done', detail: firstLine(a.reason) },
    )
  }

  const setup = await readSetup(config, userSkillsDir)
  await linkPlanTasks(setup, items, forge, ctx, onProgress)
  const attempts = await loadAttempts(attemptsPath)
  const skips = activeSkips(await loadSkips(skipsPath), Date.now())
  const planned = planRun({
    setup,
    items,
    allowances,
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
  await markShellRefused(config, planned.units, probed, ctx.env)
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
    config,
  }
}

/** Marks the units an author off `trust` steers whose provider's shell sandbox won't start where the run puts them, as the run skips them. */
export async function markShellRefused(
  config: Config,
  units: PlannedUnit[],
  providers: Record<string, Provider>,
  env: NodeJS.ProcessEnv,
) {
  for (const p of units) {
    const provider = p.provider && providers[p.provider]
    const at = provider && withholdsGrants(p.unit) && whereUnitRuns(config, p.unit.repo, env)
    if (!at) continue
    const refused = await shellRefusal(provider, at.where, p.unit, undefined, at.walled)
    if (refused) p.shellRefused = refused
  }
}

/** Where a run puts a unit of `repo`, as `isolateFor` picks it, and whether a wall holds there; none under a container without the repo's image. */
function whereUnitRuns(
  config: Config,
  repo: string,
  env: NodeJS.ProcessEnv,
): { where: Where; walled: boolean } | undefined {
  if (config.isolation === 'user' || hostedRunner(env) || inAwayworkImage(env))
    return { where: { user: WORKER }, walled: true }
  if (config.isolation !== 'container') return { where: {}, walled: false }
  const { image } = settingsFor(config.repos, repo)
  return image ? { where: { image }, walled: true } : undefined
}

export function configuredSources(config: Config): Record<string, Source> {
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
  const queue = config.queue ?? []
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
        ctx.log(sourceWarning(id, e))
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

/** The warning a source that couldn't be read leaves. */
export const sourceWarning = (id: string, e: Error & { stderr?: unknown }) =>
  `source ${id}: ${sourceFailure(e)}`

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

/** A loading step as it happens: running with how far it got, done with its result, or failed with why. */
export interface Step {
  name: string
  state: 'running' | 'done' | 'failed'
  detail?: string
}

export type OnProgress = (step: Step) => void
