import type { Command } from 'commander'
import { pausePath } from '#config/paths'
import { clearPause, pausedUntil, savePause } from '#plan/pause'
import { untilTime } from '#plan/skips'
import { printOutcome } from './skip'

export function pauseCommand(program: Command): void {
  program
    .command('pause')
    .description('hold scheduled runs (windows, run: soon, watch) on this machine until a date')
    .requiredOption('--until <date>', 'pause until this local date (YYYY-MM-DD) starts')
    .action((opts: { until: string }) => printOutcome(() => pause(opts.until)))

  program
    .command('resume')
    .description('let scheduled runs start again after awaywork pause')
    .action(() => printOutcome(() => resume()))
}

export async function pause(until: string, path = pausePath, now = Date.now()): Promise<string> {
  if ((untilTime(until) ?? 0) <= now)
    throw new Error(`--until ${until} is not a future date (YYYY-MM-DD)`)
  await savePause(path, { until })
  return `Scheduled runs paused until ${until}; awaywork resume to undo`
}

export async function resume(path = pausePath, now = Date.now()): Promise<string> {
  const until = await pausedUntil(path, now)
  await clearPause(path)
  return until
    ? `Resumed; scheduled runs were paused until ${until}`
    : 'Scheduled runs are not paused'
}
