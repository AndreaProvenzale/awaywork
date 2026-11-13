import type { Config } from '#config/schema'
import type { SkillCatalog } from '#core/skills'
import type { Ctx, Forge, Item, Thread } from '#core/types'
import type { OnProgress } from '#plan/probe'
import { ruleThread } from '#plan/queue'
import { itemState } from '#plan/where'
import { sourceFor, threadHost, writeItem } from '#sources/index'
import { taskBranches, taskPr } from '#tasks/fanout'
import { commentKind, isAwayworkComment, markComment, threadClosed } from './comments'
import { heldMove } from './posts'
import type { Moved } from './report'

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

/** Makes each move on_done held on a post of yours you approved since, with no model run; a dry run only says it. Returns the items as moved, and the moves. */
export async function makeHeldMoves(
  items: Item[],
  config: Config,
  ctx: Ctx,
  { dryRun, log }: { dryRun: boolean; log: (line: string) => void },
  mask: (line: string) => string,
): Promise<{ items: Item[]; moved: Moved[] }> {
  const out: Item[] = []
  const moved: Moved[] = []
  for (const item of items) {
    const to = item.mine && heldMove(item)
    if (!to || dryRun) {
      if (to) log(`on_done: would move ${item.key} to ${to}, its post approved`)
      out.push(item)
      continue
    }
    const cfg = config.sources[item.source]
    try {
      const write = { op: 'move', to } as const
      const { updated } = await writeItem(sourceFor(item.source, cfg), cfg, item, write, ctx)
      log(`on_done: moved ${item.key} to ${to}, its post approved`)
      moved.push({ item: `${item.source}:${item.key}`, to })
      // The move is awaywork's own change, not the card's.
      out.push(movedTo({ ...item, fields: { ...item.fields, ...(updated && { updated }) } }, to))
    } catch (e) {
      const failed = mask((e as Error).message)
      log(`on_done: couldn't move ${item.key} to ${to}: ${failed}`)
      moved.push({ item: `${item.source}:${item.key}`, to, failed })
      out.push(item)
    }
  }
  return { items: out, moved }
}

/** The item as a move to `to` leaves it, in the fields `where` reads too: a GitHub label, else the tracker's status or section. */
function movedTo(item: Item, to: string): Item {
  if (item.source === 'github')
    return {
      ...item,
      labels: [...item.labels, to],
      fields: { ...item.fields, label: [...item.labels, to] },
    }
  const swap = (v: unknown): unknown =>
    v === item.status ? to : Array.isArray(v) ? v.map(swap) : v
  const fields = { ...item.fields }
  for (const key of ['status', 'section']) if (key in fields) fields[key] = swap(fields[key])
  return { ...item, status: to, fields }
}

/** Each task an awaywork plan on a card names gets its PR, open, merged or closed: the one on its branch whose footer names it. */
export async function linkPlanTasks(
  items: Item[],
  config: Config,
  skills: SkillCatalog,
  forge: Forge,
  ctx: Ctx,
  onProgress?: OnProgress,
): Promise<void> {
  const queue = config.queue ?? []
  const tasks = taskBranches(items, config, queue, skills)
  const failed = new Set<Item>()
  for (const [i, task] of tasks.entries()) {
    onProgress?.({ name: 'reading task PRs', state: 'running', detail: `${i}/${tasks.length}` })
    task.card.taskPrs ??= {}
    const found = await forge
      .prsOn(task.repo, task.branch)
      .then(async (prs) => {
        const pr = taskPr(prs, task)
        if (pr?.state !== 'open' || !task.checks.length) return pr
        const all = await forge.checks(task.repo, pr.number)
        const named = task.checks.flatMap((name) => (all[name] ? [[name, all[name]]] : []))
        return { ...pr, checks: Object.fromEntries(named) }
      })
      .catch((e: Error) => {
        ctx.log(`reading ${task.key}'s PR on ${task.branch}: ${e.message}`)
        failed.add(task.card)
      })
    if (found) task.card.taskPrs[task.id] = found
  }
  // A card missing a task's PR can't tell which tasks still run, nor which ids are retired.
  for (const card of failed) card.taskPrs = null
  if (tasks.length)
    onProgress?.({
      name: 'reading task PRs',
      state: 'done',
      detail: `${tasks.length}/${tasks.length}`,
    })
}

/** Open tracker tasks link no PR natively, so the forge finds my PRs that name the task; a finished one links none. */
export async function linkTasks(
  items: Item[],
  forge: Forge,
  ctx: Ctx,
  onProgress?: OnProgress,
): Promise<void> {
  const tasks = items.filter(
    (i) => i.type === 'task' && itemState(i) === 'open' && i.linkedPrs.length === 0,
  )
  for (const [i, item] of tasks.entries()) {
    onProgress?.({ name: 'linking PRs', state: 'running', detail: `${i}/${tasks.length}` })
    item.linkedPrs = await forge.prsFor(item).catch((e: Error) => {
      ctx.log(`linking ${item.key} to PRs: ${e.message}`)
      return []
    })
  }
  if (tasks.length)
    onProgress?.({ name: 'linking PRs', state: 'done', detail: `${tasks.length}/${tasks.length}` })
}

/** Closes the thread of each card its source says is done, with a line saying so; a dry run only says it. */
export async function closeThreads(
  items: Item[],
  config: Pick<Config, 'sources'>,
  forge: Forge,
  ctx: Ctx,
  { dryRun, log }: { dryRun: boolean; log: (line: string) => void },
): Promise<void> {
  for (const item of items) {
    const { thread } = item
    const state = itemState(item)
    if (!thread || state === 'open') continue
    const what = `${thread.url}, ${item.key}'s thread: the card is ${state}`
    if (dryRun) log(`would close ${what}`)
    else
      await threadHost(thread.host, config.sources, forge, ctx)
        ?.closeThread(thread, markComment(threadClosed))
        .then(
          () => log(`closed ${what}`),
          (e: Error) => ctx.log(`couldn't close ${thread.url}, ${item.key}'s thread: ${e.message}`),
        )
  }
}
