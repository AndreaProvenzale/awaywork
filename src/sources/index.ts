import type { z } from 'zod'
import { markComment } from '../core/footer.js'
import type { Ctx, Item, Source, Write } from '../core/types.js'
import { asana } from './asana.js'
import { bitbucket } from './bitbucket.js'
import { commandSource, isCommand } from './command.js'
import { github } from './github.js'
import { jira } from './jira.js'
import { linear } from './linear.js'

// biome-ignore lint/suspicious/noExplicitAny: each source narrows its own config
export const sources: Record<string, Source<any>> = { github, bitbucket, asana, linear, jira }

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

/** Writes to one of your items through its source, a comment with awaywork's mark; returns the item's updated time after it. */
export async function writeItem(
  // biome-ignore lint/suspicious/noExplicitAny: each source narrows its own config
  source: Source<any> | undefined,
  cfg: unknown,
  item: Item,
  write: Write,
  ctx: Ctx,
): Promise<string | undefined> {
  const refused = unwritable(item, source)
  if (refused || !source?.write) throw new Error(refused)
  const marked = write.op === 'comment' ? { ...write, body: markComment(write.body) } : write
  return source.write(cfg, item, marked, ctx)
}
