import type { Command } from 'commander'
import { configPath, loadConfig } from '../config/load.js'
import { skipsPath } from '../config/paths.js'
import {
  activeSkips,
  describeSkip,
  loadSkips,
  type Skip,
  saveSkips,
  untilTime,
} from '../core/skips.js'

export function skipCommand(program: Command): void {
  program
    .command('skip [key]')
    .description(
      'leave an item (source:key, e.g. github:acme/api#5) alone on the coming nights; with no key, list skipped items',
    )
    .option(
      '--until <date>',
      'skip until this local date (YYYY-MM-DD) starts; default: until unskip',
    )
    .option('--reason <text>', 'why, shown by nightshift plan')
    .action((key: string | undefined, opts: Skip) =>
      printOutcome(async () => {
        if (key) return skipItem(key, opts, await configuredSources(program))
        if (opts.until || opts.reason)
          throw new Error('name the item to skip: nightshift skip <source:key>')
        return listSkips()
      }),
    )

  program
    .command('unskip <key>')
    .description('let night-shift pick up a skipped item (source:key) again')
    .action((key: string) =>
      printOutcome(async () => unskipItem(key, await configuredSources(program))),
    )
}

async function configuredSources(program: Command): Promise<string[]> {
  return Object.keys((await loadConfig(configPath(program.opts().config))).sources)
}

async function printOutcome(command: () => Promise<string>): Promise<void> {
  try {
    console.log(await command())
  } catch (e) {
    console.error((e as Error).message)
    process.exitCode = 1
  }
}

/** Items are named `source:key`: two trackers can both have an `ENG-12`. */
function checkKey(key: string, sources: string[]): void {
  const [source = '', ...rest] = key.split(':')
  if (!sources.includes(source) || !rest.join(':'))
    throw new Error(`name the item as source:key, e.g. github:acme/api#5 (got ${key})`)
}

export async function skipItem(
  key: string,
  skip: Skip,
  sources: string[],
  path = skipsPath,
  now = Date.now(),
): Promise<string> {
  checkKey(key, sources)
  if (skip.until !== undefined && (untilTime(skip.until) ?? 0) <= now)
    throw new Error(`--until ${skip.until} is not a future date (YYYY-MM-DD)`)
  const skips = await loadSkips(path)
  skips[key] = { until: skip.until, reason: skip.reason }
  await saveSkips(path, skips)
  return describeSkip(key, skip)
}

export async function unskipItem(
  key: string,
  sources: string[],
  path = skipsPath,
): Promise<string> {
  checkKey(key, sources)
  const skips = await loadSkips(path)
  if (!skips[key]) return `${key} is not skipped`
  delete skips[key]
  await saveSkips(path, skips)
  return `${key} is no longer skipped`
}

export async function listSkips(path = skipsPath, now = Date.now()): Promise<string> {
  const skips = Object.entries(activeSkips(await loadSkips(path), now))
  if (skips.length === 0) return 'No item is skipped'
  return skips.map(([key, skip]) => describeSkip(key, skip)).join('\n')
}
