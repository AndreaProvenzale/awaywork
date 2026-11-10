import { z } from 'zod'
import { markComment, type PostState } from '../core/comments.js'
import type { Ctx, Forge, Item, Source, ThreadHost, Write } from '../core/types.js'
import { itemStates } from '../core/where.js'
import { asana } from './asana.js'
import { bitbucket } from './bitbucket.js'
import { commandSource, commandThreads, isCommand } from './command.js'
import { github } from './github.js'
import { jira } from './jira.js'
import { linear } from './linear.js'
import { routines } from './routines.js'

// biome-ignore lint/suspicious/noExplicitAny: each source narrows its own config
export const sources: Record<string, Source<any>> = {
  github,
  bitbucket,
  asana,
  linear,
  jira,
  routines,
}

/** Keys every item has, whatever its source; a source sets `state`, and `closed` on a finished item. */
export const itemFields: Record<string, z.ZodType> = {
  type: z.enum(['pr', 'issue', 'task']),
  title: z.string(),
  description: z.string(),
  approved: z.string(),
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

/** Why awaywork won't write to the item: it writes only to yours, through a source that writes, or as a comment on its `thread`. */
export function unwritable(
  item: Item,
  source: Source | undefined,
  thread = false,
): string | undefined {
  if (!item.mine) return 'not yours'
  if (!source?.write && !thread) return `${item.source} can't write to its items`
}

/** Where awaywork's comments on an item go instead of the item: the card's thread, or a new one at the host `open` names. */
export interface Threads {
  forge: Forge
  /** The config's sources, the custom thread hosts among them. */
  sources?: Record<string, unknown>
  open?: string
}

/** The thread host a rule's `thread` names: the forge's GitHub issues, or a custom source with `thread: true`. */
export function threadHost(
  name: string,
  sources: Record<string, unknown>,
  forge: Forge,
  ctx: Ctx,
): ThreadHost | undefined {
  if (name === 'github') return forge.threads
  const cfg = sources[name]
  return isCommand(cfg) && cfg.thread ? commandThreads(name, cfg, ctx) : undefined
}

/** Whether awaywork's comment on the item goes to a thread: its card has one, or `threads` opens one. */
export const threaded = (item: Item, threads?: Threads): boolean =>
  !!(item.task?.parent ?? item).thread || !!threads?.open

/**
 * Writes to one of your items through its source, a comment with awaywork's mark, saying what `post` says of it; a plan's task
 * writes to its card, the only item there is. A comment goes to the card's thread instead when it has one, or when
 * `threads` opens one. Returns the item's updated time after it, unless someone changed the item since it was read:
 * then none, so their change still counts as one; and a comment's link when the source returns it.
 */
export async function writeItem(
  // biome-ignore lint/suspicious/noExplicitAny: each source narrows its own config
  source: Source<any> | undefined,
  cfg: unknown,
  item: Item,
  write: Write,
  ctx: Ctx,
  post?: PostState,
  threads?: Threads,
): Promise<{ updated?: string; url?: string }> {
  const card = item.task?.parent ?? item
  const thread = write.op === 'comment' && threaded(item, threads)
  const refused = unwritable(item, source, thread)
  if (refused) throw new Error(refused)
  if (write.op === 'comment' && thread) {
    const name = card.thread?.host ?? (threads?.open as string)
    const host = threads && threadHost(name, threads.sources ?? {}, threads.forge, ctx)
    if (!host) throw new Error(`${name} can't open threads`)
    const repo = typeof card.fields.repo === 'string' ? card.fields.repo : undefined
    // The run's later posts on the card go to the thread this one opened.
    card.thread ??= await host.openThread(repo, card)
    // A post on the thread changes neither the card nor the replies that stand for its updated time.
    return { url: await host.threadComment(card.thread, markComment(write.body, post)) }
  }
  if (!source?.write) throw new Error(`${item.source} can't write to its items`)
  const marked = write.op === 'comment' ? { ...write, body: markComment(write.body, post) } : write
  const { before, after, url } = await source.write(cfg, card, marked, ctx)
  const read = item.thread?.card ?? item.fields.updated
  const unchanged = before && typeof read === 'string' && Date.parse(before) === Date.parse(read)
  return {
    ...(unchanged && after && { updated: later(after, item.fields.updated) }),
    ...(url && { url }),
  }
}

/** `a`, unless `b` is a later time: a reply on the item's thread stands for its updated time while it's newer. */
const later = (a: string, b: unknown): string =>
  typeof b === 'string' && Date.parse(b) > Date.parse(a) ? b : a
