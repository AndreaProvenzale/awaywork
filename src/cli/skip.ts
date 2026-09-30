import type { Command } from 'commander'
import { attemptsPath } from '../config/paths.js'
import { loadAttempts, saveAttempts } from '../core/attempts.js'
import { activeSkips, describeSkip, type Skip, untilTime } from '../core/skips.js'

export function skipCommand(program: Command): void {
  program
    .command('skip [key]')
    .description('leave an item alone on the coming nights; with no key, list skipped items')
    .option(
      '--until <date>',
      'skip until this local date (YYYY-MM-DD) starts; default: until unskip',
    )
    .option('--reason <text>', 'why, shown by nightshift plan')
    .action(async (key: string | undefined, opts: Skip) => {
      try {
        console.log(key ? await skipItem(key, opts) : await listSkips())
      } catch (e) {
        console.error((e as Error).message)
        process.exitCode = 1
      }
    })

  program
    .command('unskip <key>')
    .description('let night-shift pick up a skipped item again')
    .action(async (key: string) => console.log(await unskipItem(key)))
}

export async function skipItem(
  key: string,
  skip: Skip,
  path = attemptsPath,
  now = Date.now(),
): Promise<string> {
  if (skip.until !== undefined && (untilTime(skip.until) ?? 0) <= now)
    throw new Error(`--until ${skip.until} is not a future date (YYYY-MM-DD)`)
  const state = await loadAttempts(path)
  state[key] = { ...state[key], skip: { until: skip.until, reason: skip.reason } }
  await saveAttempts(path, state)
  return describeSkip(key, skip)
}

export async function unskipItem(key: string, path = attemptsPath): Promise<string> {
  const state = await loadAttempts(path)
  const entry = state[key]
  if (!entry?.skip) return `${key} is not skipped`
  delete entry.skip
  if (Object.keys(entry).length === 0) delete state[key]
  await saveAttempts(path, state)
  return `${key} is no longer skipped`
}

export async function listSkips(path = attemptsPath, now = Date.now()): Promise<string> {
  const skips = Object.entries(activeSkips(await loadAttempts(path), now))
  if (skips.length === 0) return 'No item is skipped'
  return skips.map(([key, skip]) => describeSkip(key, skip)).join('\n')
}
