import type { Command } from 'commander'
import { configPath, loadConfig } from '../config/load.js'
import { approvalsPath } from '../config/paths.js'
import type { Config } from '../config/schema.js'
import { loadApprovals, saveApprovals } from '../core/approvals.js'
import { approveReply } from '../core/footer.js'
import { planThread } from '../core/plan.js'
import type { Ctx, Source } from '../core/types.js'
import { sourceFor, writeItem } from '../sources/index.js'
import { checkKey, printOutcome } from './skip.js'

export function approveCommand(program: Command): void {
  program
    .command('approve <key> [notes...]')
    .description(
      'approve the plan an item (source:key, e.g. github:acme/api#5) waits on, replying approve on it with the notes below; otherwise mark it approved, for rules with `where: { approved: true }`, until a unit on it finishes',
    )
    .action((key: string, notes: string[]) =>
      printOutcome(async () =>
        approveItem(key, await loadConfig(configPath(program.opts().config)), notes.join(' ')),
      ),
    )
}

/**
 * Replies `approve` on the item when it waits on a plan, through its source as any write; refuses
 * once the plan was answered. Any other item it approves locally.
 */
export async function approveItem(
  key: string,
  config: Pick<Config, 'sources'>,
  notes = '',
  {
    path = approvalsPath,
    sources = {},
    ctx = { env: process.env, log: (line) => console.error(line) },
  }: { path?: string; sources?: Record<string, Source>; ctx?: Ctx } = {},
): Promise<string> {
  checkKey(key, Object.keys(config.sources))
  const id = key.slice(0, key.indexOf(':'))
  const cfg = config.sources[id]
  const source = sources[id] ?? sourceFor(id, cfg)
  const item = source && (await source.items(cfg, ctx)).find((i) => `${id}:${i.key}` === key)
  const thread = item && planThread(item)
  if (item && thread?.answer)
    throw new Error(
      `the plan on ${item.url} was already answered by ${thread.answer.author}, ${thread.answer.at}`,
    )
  if (item && thread) {
    const write = { op: 'comment', body: approveReply(notes) } as const
    const { url = item.url } = await writeItem(source, cfg, item, write, ctx)
    return `plan approved: replied approve${notes.trim() ? ', with your notes,' : ''} on ${url}`
  }
  if (notes.trim()) throw new Error(`${key} waits on no plan: notes go only with a plan's approval`)
  const approvals = await loadApprovals(path)
  approvals[key] = true
  await saveApprovals(path, approvals)
  return `${key} is approved until a unit on it finishes`
}
