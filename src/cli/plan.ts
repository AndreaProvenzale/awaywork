import type { Command } from 'commander'
import { configPath, loadConfig } from '../config/load.js'
import { userSkillsDir } from '../config/paths.js'
import type { Config } from '../config/schema.js'
import { loadSkills } from '../config/skills.js'
import { type Allowance, allowance } from '../core/budget.js'
import { type NightPlan, planNight } from '../core/foreman.js'
import { builtinSkills } from '../core/skills.js'
import type { Ctx, Forge, Item } from '../core/types.js'
import { githubForge } from '../forge/github.js'
import { providers } from '../providers/index.js'
import { sources } from '../sources/index.js'
import { reportConfigError } from './config.js'
import { formatPlan, planJson } from './format.js'

export function planCommand(program: Command): void {
  program
    .command('plan')
    .description("show tonight's units in order, with each provider's ceiling; runs no worker")
    .option('--json', 'print the plan and warnings as JSON')
    .action(async (opts: { json?: boolean }) => {
      try {
        const config = await loadConfig(configPath(program.opts().config))
        const { plan, warnings } = await planTonight(config)
        console.log(opts.json ? planJson(plan, warnings) : formatPlan(plan, warnings, true))
      } catch (e) {
        reportConfigError(e)
      }
    })
}

/** Collects items from every configured source, probes every provider and plans the night. */
export async function planTonight(
  config: Config,
): Promise<{ plan: NightPlan; warnings: string[]; ctx: Ctx }> {
  const warnings: string[] = []
  const ctx: Ctx = { env: process.env, log: (line) => warnings.push(line) }

  const items = await collectItems(config, ctx)

  const allowances: Record<string, Allowance> = {}
  for (const p of config.providers) {
    let reason: string | undefined
    const quota = await providers[p.id]?.probe(ctx).catch((e: Error) => {
      reason = `probe failed: ${e.message}`
      return null
    })
    allowances[p.id] = allowance(p.budget, quota ?? null, Date.now(), reason)
  }

  const skills = { user: await loadSkills(userSkillsDir), builtin: builtinSkills }
  return { plan: planNight({ config, items, allowances, skills }), warnings, ctx }
}

/** Items from every configured source, tasks linked to their PRs; a failing source is logged. */
export async function collectItems(config: Config, ctx: Ctx): Promise<Item[]> {
  const items: Item[] = []
  for (const [id, cfg] of Object.entries(config.sources)) {
    const source = sources[id]
    if (!source) continue
    await source.items(cfg, ctx).then(
      (found) => items.push(...found),
      (e: Error) => ctx.log(`source ${id}: ${e.message}`),
    )
  }
  await linkTasks(items, githubForge(), ctx)
  return items
}

/** Tracker tasks link no PR natively, so the forge finds my PRs carrying the task key. */
export async function linkTasks(items: Item[], forge: Forge, ctx: Ctx): Promise<void> {
  for (const item of items.filter((i) => i.type === 'task' && i.linkedPrs.length === 0))
    item.linkedPrs = await forge.prsFor(item).catch((e: Error) => {
      ctx.log(`linking ${item.key} to PRs: ${e.message}`)
      return []
    })
}
