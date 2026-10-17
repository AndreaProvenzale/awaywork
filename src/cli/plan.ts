import { type Command, Option } from 'commander'
import { configPath, loadConfig } from '../config/load.js'
import { attemptsPath, skillsDirOf, skipsPath } from '../config/paths.js'
import type { Config } from '../config/schema.js'
import { loadSkills } from '../config/skills.js'
import { loadAttempts } from '../core/attempts.js'
import { type Allowance, allowance } from '../core/budget.js'
import { renderLink } from '../core/footer.js'
import { planRun, type RunPlan } from '../core/foreman.js'
import { defaultRules } from '../core/queue.js'
import { builtinSkills } from '../core/skills.js'
import { activeSkips, loadSkips } from '../core/skips.js'
import type { Ctx, Forge, Item, Source } from '../core/types.js'
import { describeWindow, HOSTED_RUN_MINUTES, tooLongForHosted } from '../core/window.js'
import { githubForge } from '../forge/github.js'
import { providers } from '../providers/index.js'
import { sourceFor } from '../sources/index.js'
import { maskSecrets } from '../worker/setup.js'
import { configSecrets } from '../worker/workspace.js'
import { reportConfigError } from './config.js'
import { formatPlan, formatRules, planJson, warningLines } from './format.js'

export function planCommand(program: Command): void {
  program
    .command('plan')
    .description("show the next run's units in order, with each provider's ceiling; runs no worker")
    .option('--json', 'print the plan and warnings as JSON')
    .addOption(
      new Option(
        '--rules',
        'show what each rule takes now and what earlier rules take from it, instead of the units; probes no provider',
      ).conflicts('json'),
    )
    .action(async (opts: { json?: boolean; rules?: boolean }) => {
      try {
        const path = configPath(program.opts().config)
        const config = await loadConfig(path)
        if (opts.rules) return console.log(await describeRules(config))
        const { plan, warnings } = await probeAndPlan(config, skillsDirOf(path))
        console.log(opts.json ? planJson(plan, warnings) : formatPlan(plan, warnings, true))
      } catch (e) {
        reportConfigError(e)
      }
    })
}

/** Collects items from every configured source, probes every provider and plans the run, masking secrets in warnings. */
export async function probeAndPlan(
  config: Config,
  userSkillsDir: string,
  opts: { retry?: boolean } = {},
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

  const items = await collectItems(config, ctx)

  const allowances: Record<string, Allowance> = {}
  for (const p of config.providers) {
    const unavailable = providers[p.id]?.unavailable?.(ctx.env)
    if (unavailable) {
      warnings.push(`${p.id} unavailable: ${unavailable}`)
      continue
    }
    let reason: string | undefined
    const quota = await providers[p.id]?.probe(ctx).catch((e: Error) => {
      reason = `probe failed: ${e.message}`
      return null
    })
    allowances[p.id] = allowance(p.budget, quota ?? null, Date.now(), config.windows, reason)
  }

  const skills = { user: await loadSkills(userSkillsDir), builtin: builtinSkills }
  const attempts = opts.retry ? {} : await loadAttempts(attemptsPath)
  const skips = opts.retry ? {} : activeSkips(await loadSkips(skipsPath), Date.now())
  const sources = configuredSources(config)
  // A failed source's warning carries its stderr, and coding agents read `plan`.
  const secrets = configSecrets(config, providers, sources)
  return {
    plan: planRun({ config, items, allowances, skills, attempts, skips }),
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
  const items = await collectItems(config, ctx)
  const secrets = configSecrets(config, providers, configuredSources(config))
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
export async function collectItems(config: Config, ctx: Ctx): Promise<Item[]> {
  const items: Item[] = []
  for (const [id, cfg] of Object.entries(config.sources)) {
    const source = sourceFor(id, cfg)
    if (!source) continue
    const link = (cfg as { link?: string }).link ?? source.link
    await source.items(cfg, ctx).then(
      (found) => items.push(...found.map((i) => (link ? { ...i, link: renderLink(link, i) } : i))),
      (e: Error) => ctx.log(`source ${id}: ${e.message}`),
    )
  }
  await linkTasks(
    items,
    githubForge(undefined, (config.sources.github as { host?: string } | undefined)?.host),
    ctx,
  )
  return items
}

/** Tracker tasks link no PR natively, so the forge finds my PRs that name the task. */
export async function linkTasks(items: Item[], forge: Forge, ctx: Ctx): Promise<void> {
  for (const item of items.filter((i) => i.type === 'task' && i.linkedPrs.length === 0))
    item.linkedPrs = await forge.prsFor(item).catch((e: Error) => {
      ctx.log(`linking ${item.key} to PRs: ${e.message}`)
      return []
    })
}
