import { clip } from '../cli/format/terminal.js'
import { attemptsPath, skipsPath } from '../config/paths.js'
import type { Config } from '../config/schema.js'
import { loadSkills } from '../config/skills.js'
import { builtinSkills } from '../core/skills.js'
import type { Ctx, Forge, Item, Rule, Source } from '../core/types.js'
import { forgeFor } from '../forge/index.js'
import { renderLink } from '../posts/footer.js'
import { withApproved } from '../posts/posts.js'
import { counted } from '../posts/report.js'
import {
  closeThreads,
  linkPlanTasks,
  linkTasks,
  linkThreads,
  makeHeldMoves,
} from '../posts/threads.js'
import { providerFor, providersOf } from '../providers/index.js'
import { type Allowance, allowance, pct } from '../quota/budget.js'
import { describeWindow, HOSTED_RUN_MINUTES, tooLongForHosted, windowEnd } from '../quota/window.js'
import { sourceFor } from '../sources/index.js'
import { nextOccurrences, type RoutinesConfig } from '../sources/routines.js'
import { configSecrets } from '../worker/secrets.js'
import { maskSecrets } from '../worker/setup.js'
import { checkPins } from '../worker/store.js'
import { loadAttempts } from './attempts.js'
import { planRun, type RunPlan } from './foreman.js'
import { ruleThread } from './queue.js'
import { activeSkips, loadSkips } from './skips.js'
import { DEFAULT_LOOKBACK, itemState, lookback, spanMs } from './where.js'

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
