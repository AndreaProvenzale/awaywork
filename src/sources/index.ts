import { z } from 'zod'
import { markComment } from '../core/footer.js'
import { itemStates } from '../core/queue.js'
import type { Ctx, Item, Source, Write } from '../core/types.js'
import { asana } from './asana.js'
import { bitbucket } from './bitbucket.js'
import { commandSource, isCommand } from './command.js'
import { github } from './github.js'
import { jira } from './jira.js'
import { linear } from './linear.js'

// biome-ignore lint/suspicious/noExplicitAny: each source narrows its own config
export const sources: Record<string, Source<any>> = { github, bitbucket, asana, linear, jira }

/** Keys every item has, whatever its source; a source sets `state`, and `closed` on a finished item. */
export const itemFields: Record<string, z.ZodType> = {
  type: z.enum(['pr', 'issue', 'task']),
  title: z.string(),
  description: z.string(),
  approved: z.boolean(),
  state: z.enum(itemStates),
  closed: z.iso.datetime({ offset: true }),
  /** A task of an approved plan, which only a rule naming it takes. */
  planned: z.literal(true),
}

/** The built-in source with this id, else the command source its config describes. */
// biome-ignore lint/suspicious/noExplicitAny: each source narrows its own config
export function sourceFor(id: string, cfg: unknown): Source<any> | undefined {
  return sources[id] ?? (isCommand(cfg) ? commandSource(id, cfg) : undefined)
}

/** The schema a `where` key matches against; a `prefix.*` field declares every `prefix.<name>`. */
export function sourceField(fields: Source['fields'], key: string): z.ZodType | undefined {
  const dot = key.indexOf('.')
  return fields[key] ?? (dot > 0 ? fields[`${key.slice(0, dot)}.*`] : undefined)
}

/** Why awaywork won't write to the item: it writes only to yours, through a source that writes. */
export function unwritable(item: Item, source: Source | undefined): string | undefined {
  if (!item.mine) return 'not yours'
  if (!source?.write) return `${item.source} can't write to its items`
}

/**
 * Writes to one of your items through its source, a comment with awaywork's mark; a plan's task
 * writes to its card, the only item there is. Returns the item's updated time after it, unless
 * someone changed the item since it was read: then none, so their change still counts as one;
 * and a comment's link when the source returns it.
 */
export async function writeItem(
  // biome-ignore lint/suspicious/noExplicitAny: each source narrows its own config
  source: Source<any> | undefined,
  cfg: unknown,
  item: Item,
  write: Write,
  ctx: Ctx,
): Promise<{ updated?: string; url?: string }> {
  const refused = unwritable(item, source)
  if (refused || !source?.write) throw new Error(refused)
  const marked = write.op === 'comment' ? { ...write, body: markComment(write.body) } : write
  const { before, after, url } = await source.write(cfg, item.task?.parent ?? item, marked, ctx)
  const read = item.fields.updated
  const unchanged = before && typeof read === 'string' && Date.parse(before) === Date.parse(read)
  return { ...(unchanged && after && { updated: after }), ...(url && { url }) }
}
