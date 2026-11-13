import { type Command, InvalidArgumentError, Option } from 'commander'
import { configPath, loadConfig } from '../../config/load.js'
import { skillsDirOf } from '../../config/paths.js'
import type { Config } from '../../config/schema.js'
import type { Ctx } from '../../core/types.js'
import { planJson } from '../../format/json.js'
import { formatPlan } from '../../format/plan.js'
import { formatQueue, rulesJson } from '../../format/rules.js'
import { formatSkipped } from '../../format/skips.js'
import { warningLines } from '../../format/terminal.js'
import { ambiguous, formatWhy, namedItems } from '../../format/why.js'
import { needsYou } from '../../plan/foreman.js'
import { collectItems, configuredSources, probeAndPlan } from '../../plan/probe.js'
import { providersOf } from '../../providers/index.js'
import { configSecrets } from '../../worker/secrets.js'
import { maskSecrets } from '../../worker/setup.js'
import { reportConfigError } from '../tui/ask.js'
import { interactive, itemCommands, openScreen } from '../tui/browse.js'
import { planTriage } from '../tui/triage.js'

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

/** The queue with what each rule takes now, as text or JSON; reads the sources, probes no provider. */
async function describeRules(config: Config, json = false): Promise<string> {
  const warnings: string[] = []
  const ctx: Ctx = { env: process.env, log: (line) => warnings.push(line) }
  const items = await collectItems(config, ctx)
  const secrets = configSecrets(config, providersOf(config), configuredSources(config))
  const masked = warnings.map((w) => maskSecrets(w, secrets, ctx.env))
  const rules = config.queue ?? []
  if (json) return rulesJson(rules, items, masked)
  return [...warningLines(masked), ...formatQueue(rules, items)].join('\n')
}
