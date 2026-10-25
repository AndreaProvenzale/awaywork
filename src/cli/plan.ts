import { type Command, InvalidArgumentError, Option } from 'commander'
import { configPath, loadConfig } from '../config/load.js'
import { approvalsPath, attemptsPath, skillsDirOf, skipsPath } from '../config/paths.js'
import type { Config } from '../config/schema.js'
import { loadSkills } from '../config/skills.js'
import { loadApprovals, withApprovals } from '../core/approvals.js'
import { loadAttempts } from '../core/attempts.js'
import { type Allowance, allowance, pct } from '../core/budget.js'
import { renderLink } from '../core/footer.js'
import { needsYou, planRun, type RunPlan } from '../core/foreman.js'
import { defaultRules, itemState, lookback } from '../core/queue.js'
import { counted } from '../core/report.js'
import { builtinSkills } from '../core/skills.js'
import { activeSkips, loadSkips } from '../core/skips.js'
import type { Ctx, Forge, Item, Rule, Source } from '../core/types.js'
import { describeWindow, HOSTED_RUN_MINUTES, tooLongForHosted } from '../core/window.js'
import { forgeFor } from '../forge/index.js'
import { providerFor, providersOf } from '../providers/index.js'
import { sourceFor } from '../sources/index.js'
import { maskSecrets } from '../worker/setup.js'
import { configSecrets } from '../worker/workspace.js'
import { interactive, itemCommands, openScreen } from './browse.js'
import { reportConfigError } from './config.js'
import {
  ambiguous,
  clip,
  formatPlan,
  formatRules,
  formatSkipped,
  formatWhy,
  namedItems,
  planJson,
  warningLines,
} from './format.js'
import { type OnProgress, planTriage } from './triage.js'

export function planCommand(program: Command): void {
  program
    .command('plan')
    .description(
      "show the next run's units in order, with each provider's ceiling; runs no worker; browsable in a terminal",
    )
    .option('--json', 'print the plan and warnings as JSON')
    .option('--repo <glob>', 'only units in repos matching owner/name, * globs')
    .option('--rule <n>', 'only units of this queue rule, counted from 1', ruleNumber)
    .addOption(
      new Option(
        '--rules',
        'show what each rule takes now and what earlier rules take from it, instead of the units; probes no provider',
      ).conflicts('json'),
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
        if (opts.rules) return console.log(await describeRules(config))
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
          const sources = Object.keys(config.sources)
          const state = planTriage(plan, warnings, process.stdout.rows)
          return await screen.browse(
            { ...state, status: none },
            itemCommands(async () => sources),
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

/** Collects items from every configured source, probes every provider and plans the run, masking secrets in warnings. */
export async function probeAndPlan(
  config: Config,
  userSkillsDir: string,
  opts: { retry?: boolean; repo?: string; rule?: number; onProgress?: OnProgress } = {},
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

  const { onProgress } = opts
  const items = withApprovals(
    await collectItems(config, ctx, onProgress),
    await loadApprovals(approvalsPath),
  )

  const allowances: Record<string, Allowance> = {}
  for (const p of config.providers) {
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
    const a = allowance(p.budget, quota ?? null, Date.now(), config.windows, reason)
    allowances[p.id] = a
    onProgress?.(
      a.kind === 'quota'
        ? { name, state: 'done', detail: `${pct(a.used)} of ${pct(a.ceiling)}` }
        : { name, state: reason ? 'failed' : 'done', detail: firstLine(a.reason) },
    )
  }

  const skills = { user: await loadSkills(userSkillsDir), builtin: builtinSkills }
  const attempts = opts.retry ? {} : await loadAttempts(attemptsPath)
  const skips = opts.retry ? {} : activeSkips(await loadSkips(skipsPath), Date.now())
  const sources = configuredSources(config)
  // A failed source's warning carries its stderr, and coding agents read `plan`.
  const secrets = configSecrets(config, providersOf(config), sources)
  return {
    plan: planRun({ config, items, allowances, skills, attempts, skips, only: opts }),
    warnings: warnings.map((w) => maskSecrets(w, secrets, ctx.env)),
    ctx,
    sources,
    secrets,
  }
}

/** The queue with what each rule takes now; reads the sources, probes no provider. */
async function describeRules(config: Config): Promise<string> {
  const warnings: string[] = []
  const ctx: Ctx = { env: process.env, log: (line) => warnings.push(line) }
  const items = withApprovals(await collectItems(config, ctx), await loadApprovals(approvalsPath))
  const secrets = configSecrets(config, providersOf(config), configuredSources(config))
  return [
    ...warningLines(warnings.map((w) => maskSecrets(w, secrets, ctx.env))),
    config.queue ? 'Queue' : 'Queue (default: no queue in config)',
    ...formatRules(config.queue ?? defaultRules(Object.keys(config.sources)), items).map(
      (line) => `  ${line}`,
    ),
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

/** Items from every configured source with their link lines, tasks linked to their PRs; a failing source is logged. */
export async function collectItems(
  config: Config,
  ctx: Ctx,
  onProgress?: OnProgress,
): Promise<Item[]> {
  const items: Item[] = []
  const queue = config.queue ?? defaultRules(Object.keys(config.sources))
  for (const [id, cfg] of Object.entries(config.sources)) {
    const source = sourceFor(id, cfg)
    if (!source) continue
    const link = (cfg as { link?: string }).link ?? source.link
    onProgress?.({ name: id, state: 'running' })
    await source.items(cfg, ctx, finishedSince(queue, id)).then(
      (found) => {
        items.push(...found.map((i) => (link ? { ...i, link: renderLink(link, i) } : i)))
        onProgress?.({ name: id, state: 'done', detail: counted(found.length, 'item') })
      },
      (e: Error) => {
        ctx.log(`source ${id}: ${sourceFailure(e)}`)
        onProgress?.({ name: id, state: 'failed', detail: firstLine(e.message) })
      },
    )
  }
  await linkTasks(items, forgeFor(config), ctx, onProgress)
  return items
}

const firstLine = (text: string) => text.split('\n')[0]

/** How far back the source's rules read finished items, the widest wins; unset when none does. */
export function finishedSince(queue: Rule[], source: string): Date | undefined {
  const reach = queue
    .filter((r) => !r.source || r.source === source)
    .flatMap((r) => lookback(r.where) ?? [])
  return reach.length > 0 ? new Date(Date.now() - Math.max(...reach)) : undefined
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
