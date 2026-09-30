import type { Command } from 'commander'
import { skipsPath } from '../config/paths.js'
import {
  activeSkips,
  describeSkip,
  loadSkips,
  type Skip,
  saveSkips,
  untilTime,
} from '../core/skips.js'
import { sources } from '../sources/index.js'

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
        if (key) return skipItem(key, opts)
        if (opts.until || opts.reason)
          throw new Error('name the item to skip: nightshift skip <source:key>')
        return listSkips()
      }),
    )

  program
    .command('unskip <key>')
    .description('let night-shift pick up a skipped item (source:key) again')
    .action((key: string) => printOutcome(() => unskipItem(key)))
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
function checkKey(key: string): void {
  const [source = '', ...rest] = key.split(':')
  if (!Object.hasOwn(sources, source) || !rest.join(':'))
    throw new Error(`name the item as source:key, e.g. github:acme/api#5 (got ${key})`)
}

export async function skipItem(
  key: string,
  skip: Skip,
  path = skipsPath,
  now = Date.now(),
): Promise<string> {
  checkKey(key)
  if (skip.until !== undefined && (untilTime(skip.until) ?? 0) <= now)
    throw new Error(`--until ${skip.until} is not a future date (YYYY-MM-DD)`)
  const skips = await loadSkips(path)
  skips[key] = { until: skip.until, reason: skip.reason }
  await saveSkips(path, skips)
  return describeSkip(key, skip)
}

export async function unskipItem(key: string, path = skipsPath): Promise<string> {
  checkKey(key)
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
