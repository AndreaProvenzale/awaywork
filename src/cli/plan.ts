import type { Command } from 'commander'
import { configPath, loadConfig } from '../config/load.js'
import { userSkillsDir } from '../config/paths.js'
import { loadSkills } from '../config/skills.js'
import { type Allowance, allowance } from '../core/budget.js'
import { planNight } from '../core/foreman.js'
import { builtinSkills } from '../core/skills.js'
import type { Ctx, Item } from '../core/types.js'
import { providers } from '../providers/index.js'
import { sources } from '../sources/index.js'
import { reportConfigError } from './config.js'
import { formatPlan } from './format.js'

export function planCommand(program: Command): void {
  program
    .command('plan')
    .description("show tonight's units in order, with each provider's ceiling; runs no worker")
    .action(async () => {
      try {
        const config = await loadConfig(configPath(program.opts().config))
        const warnings: string[] = []
        const ctx: Ctx = { env: process.env, log: (line) => warnings.push(line) }

        const items: Item[] = []
        for (const [id, cfg] of Object.entries(config.sources)) {
          const source = sources[id]
          if (!source) continue
          await source.items(cfg, ctx).then(
            (found) => items.push(...found),
            (e: Error) => warnings.push(`source ${id}: ${e.message}`),
          )
        }

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
        console.log(formatPlan(planNight({ config, items, allowances, skills }), warnings))
      } catch (e) {
        reportConfigError(e)
      }
    })
}
