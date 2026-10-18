import type { Command } from 'commander'
import { approvalsPath } from '../config/paths.js'
import { loadApprovals, saveApprovals } from '../core/approvals.js'
import { checkKey, configuredSources, printOutcome } from './skip.js'

export function approveCommand(program: Command): void {
  program
    .command('approve <key>')
    .description(
      'mark an item (source:key, e.g. github:acme/api#5) approved, for rules with `where: { approved: true }`; a unit that finishes on it clears the approval',
    )
    .action((key: string) =>
      printOutcome(async () => approveItem(key, await configuredSources(program))),
    )
}

export async function approveItem(
  key: string,
  sources: string[],
  path = approvalsPath,
  now = new Date(),
): Promise<string> {
  checkKey(key, sources)
  const approvals = await loadApprovals(path)
  approvals[key] = { at: now.toISOString() }
  await saveApprovals(path, approvals)
  return `${key} is approved until a unit on it finishes`
}
