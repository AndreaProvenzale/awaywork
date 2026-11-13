import type { Config } from '../config/schema.js'
import type { Ctx, Forge, Item, Thread } from '../core/types.js'
import { ruleThread } from '../plan/queue.js'
import { commentKind, isAwayworkComment } from '../posts/comments.js'
import { threadHost } from '../sources/index.js'

/** Each thread host a rule names, with the sources its rules take items from. */
export function threadHosts(config: Pick<Config, 'sources' | 'queue'>): Map<string, string[]> {
  const hosts = new Map<string, string[]>()
  for (const r of config.queue ?? []) {
    const host = ruleThread(r)
    if (host)
      hosts.set(host, [
        ...(hosts.get(host) ?? []),
        ...(r.source ? [r.source] : Object.keys(config.sources)),
      ])
  }
  return hosts
}

/**
 * Each of your items a rule with a `thread` can take gets the thread awaywork opened for it, if any: its comments
 * follow the card's, and a reply there changes the item as one on the card would. Returns the items but those whose
 * threads couldn't be read: planned without them, they'd post a second plan.
 */
export async function linkThreads(
  items: Item[],
  config: Pick<Config, 'sources' | 'queue'>,
  forge: Forge,
  ctx: Ctx,
): Promise<Item[]> {
  const unread = new Set<Item>()
  for (const [name, sources] of threadHosts(config)) {
    const host = threadHost(name, config.sources, forge, ctx)
    const repoOf = (i: Item) =>
      host?.byRepo && typeof i.fields.repo === 'string' ? i.fields.repo : undefined
    const threaded = items.filter(
      (i) => i.mine && !i.thread && sources.includes(i.source) && (!host?.byRepo || repoOf(i)),
    )
    for (const repo of new Set(threaded.map(repoOf))) {
      const here = threaded.filter((i) => repoOf(i) === repo)
      const found = await host?.threads(repo).catch((e: Error) => {
        const keys = here.map((i) => i.key).join(', ')
        const on = repo ? `in ${repo}` : `on ${name}`
        ctx.log(`couldn't read awaywork's threads ${on}, so left out ${keys}: ${e.message}`)
        for (const item of here) unread.add(item)
      })
      for (const item of here) {
        const thread = found?.find((t) => t.item === `${item.source}:${item.key}`)
        if (thread) linkThread(item, thread)
      }
    }
  }
  return items.filter((i) => !unread.has(i))
}

/** The item with its thread's comments after its own, and the newest reply there as its updated time when newer. */
function linkThread(
  item: Item,
  { thread, comments }: { thread: Thread; comments: Item['comments'] },
): void {
  // Awaywork's own posts there leave the item as it was, as they do on the card.
  const replied = comments
    .filter((c) => !isAwayworkComment(c) || commentKind(c) === 'approve')
    .at(-1)?.at
  const card = item.fields.updated
  const newer = !!replied && !(typeof card === 'string' && Date.parse(card) >= Date.parse(replied))
  item.thread = { ...thread, ...(newer && typeof card === 'string' && { card }) }
  item.comments = [...item.comments, ...comments]
  if (newer) item.fields.updated = replied
}
