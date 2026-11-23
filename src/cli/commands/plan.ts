import { type Command, InvalidArgumentError, Option } from 'commander'
import { reportConfigError } from '#cli/tui/ask'
import { interactive, itemCommands, openScreen } from '#cli/tui/browse'
import { planTriage, screenJson } from '#cli/tui/triage'
import { configPath, loadConfig } from '#config/load'
import { skillsDirOf } from '#config/paths'
import type { Config } from '#config/schema'
import { inAwayworkImage } from '#core/isolation/sudo'
import { workerFor } from '#core/isolation/user'
import { NET_ADMIN_FIX, wallProblem } from '#core/isolation/user-wall'
import type { Ctx } from '#core/types'
import { resolveTeams } from '#forge/teams'
import { planJson } from '#format/json'
import { formatPlan } from '#format/plan'
import { formatQueue, rulesJson } from '#format/rules'
import { formatSkipped } from '#format/skips'
import { warningLines } from '#format/terminal'
import { ambiguous, formatWhy, namedItems } from '#format/why'
import { needsYou } from '#plan/foreman'
import { collectItems, configuredSources, probeAndPlan } from '#plan/probe'
import { providersOf } from '#providers/index'
import { configSecrets } from '#worker/clone/context'
import { maskSecrets } from '#worker/process/command'

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
    .addOption(new Option('--screen').hideHelp().conflicts(['json', 'rules', 'skipped', 'why']))
    .action(async (opts: PlanOptions) => {
      const browsing =
        interactive() && !opts.json && !opts.rules && !opts.skipped && !opts.why && !opts.screen
      const screen = browsing ? openScreen('Planning the next run') : undefined
      try {
        const path = configPath(program.opts().config)
        const config = await loadConfig(path)
        if (opts.rules) return console.log(await describeRules(config, opts.json))
        const { plan, warnings } = await probeAndPlan(config, skillsDirOf(path), {
          ...opts,
          onProgress: screen?.progress,
        })
        const unwalled = await wallWarning(config)
        if (unwalled) warnings.push(unwalled)
        const none =
          !plan.units.length && (opts.repo !== undefined || opts.rule !== undefined)
            ? 'no unit matches --repo/--rule'
            : undefined
        if (none && !screen && !opts.screen) console.error(none)
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
        const state = () => ({
          ...planTriage(plan, warnings, process.stdout.rows, none),
          status: plan.skipped.length ? none : undefined,
        })
        if (opts.screen) return console.log(screenJson(state()))
        if (screen)
          return await screen.browse(
            state(),
            itemCommands(async () => config),
          )
        console.log(opts.json ? planJson(plan, warnings) : formatPlan(plan, warnings, true))
      } catch (e) {
        screen?.close()
        reportConfigError(e)
      }
    })
}

/** Under `user` and in awaywork's image, a run refuses as a whole while the worker's network wall isn't up. */
async function wallWarning(config: Config): Promise<string | undefined> {
  if (config.isolation !== 'user' && !inAwayworkImage(process.env)) return
  const worker = await workerFor(config.isolation, process.env).catch(() => undefined)
  const problem = worker && (await wallProblem(worker))
  if (problem)
    return `no unit runs: the network wall isn't up for ${worker} (${problem}): ${inAwayworkImage(process.env) ? NET_ADMIN_FIX : '`awaywork doctor` shows the rules'}`
}

type PlanOptions = {
  json?: boolean
  rules?: boolean
  repo?: string
  rule?: number
  skipped?: string | true
  why?: string
  /** Print the view as JSON, for a laptop to browse. */
  screen?: boolean
}

/** What `--skipped` filters on. */
export const skipKinds = Object.keys(needsYou)

export function ruleNumber(text: string): number {
  const n = Number(text)
  if (!Number.isInteger(n) || n < 1) throw new InvalidArgumentError('a rule number from 1')
  return n
}

/** The queue with what each rule takes now, as text or JSON; reads the sources, probes no provider. */
async function describeRules(given: Config, json = false): Promise<string> {
  const warnings: string[] = []
  const ctx: Ctx = { env: process.env, log: (line) => warnings.push(line) }
  const config = await resolveTeams(given, ctx.log)
  const items = await collectItems(config, ctx)
  const secrets = configSecrets(config, providersOf(config), configuredSources(config))
  const masked = warnings.map((w) => maskSecrets(w, secrets, ctx.env))
  const rules = config.queue ?? []
  if (json) return rulesJson(rules, items, masked)
  return [...warningLines(masked), ...formatQueue(rules, items)].join('\n')
}
