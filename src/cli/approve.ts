import type { Command } from 'commander'
import { configPath, loadConfig } from '../config/load.js'
import type { Config } from '../config/schema.js'
import { approveReply, commentTask, postState } from '../core/comments.js'
import { cardTasks, planThread } from '../core/plan.js'
import { decisionPost } from '../core/posts.js'
import type { Ctx, Forge, Source } from '../core/types.js'
import { forgeFor } from '../forge/index.js'
import { sourceFor, writeItem } from '../sources/index.js'
import { checkKey, printOutcome } from './skip.js'
import { linkThreads, threadHosts } from './threads.js'

export function approveCommand(program: Command): void {
  program
    .command('approve <key> [notes...]')
    .description(
      'approve the plan or result an item (source:key, e.g. github:acme/api#5) waits on, replying approve on it with the notes below',
    )
    .action((key: string, notes: string[]) =>
      printOutcome(async () =>
        approveItem(key, await loadConfig(configPath(program.opts().config)), notes.join(' ')),
      ),
    )
}

/** Replies `approve` on the item when awaywork's post on it waits, a plan or a result, through its source as any write; refuses once it was answered or went ahead, or when nothing waits. */
export async function approveItem(
  key: string,
  config: Pick<Config, 'sources' | 'queue'>,
  notes = '',
  {
    sources = {},
    ctx = { env: process.env, log: (line) => console.error(line) },
    forge = forgeFor(config as Config),
  }: { sources?: Record<string, Source>; ctx?: Ctx; forge?: Forge } = {},
): Promise<string> {
  const hosts = threadHosts(config)
  checkKey(key, [...Object.keys(config.sources), ...hosts.keys()])
  const read = async (id: string) => {
    const cfg = config.sources[id]
    const source = cfg ? (sources[id] ?? sourceFor(id, cfg)) : undefined
    const items = source ? await source.items(cfg, ctx) : []
    return { cfg, source, items: await linkThreads(items, config, forge, ctx) }
  }
  // A thread isn't an item of its host: its key names the card it's the thread of.
  const thread = async () => {
    for (const other of new Set([...hosts.values()].flat())) {
      const found = await read(other)
      const card = found.items.find((i) => i.thread && `${i.thread.host}:${i.thread.key}` === key)
      if (card) return { ...found, item: card }
    }
  }
  const id = key.slice(0, key.indexOf(':'))
  const named = await read(id)
  const own = named.items.find((i) => `${id}:${i.key}` === key)
  const { cfg, source, items, item } = (!own && hosts.has(id) && (await thread())) || {
    ...named,
    item: own,
  }
  const card = !item && items.find((i) => key.startsWith(`${id}:${i.key}/`) && planThread(i))
  const task = card && key.slice(`${id}:${card.key}/`.length)
  if (card && !cardTasks(card).some((t) => t.id === task))
    throw new Error(`the plan on ${id}:${card.key} has no task ${task}`)
  // A task's result waits only when a gate of its rule fired, on its card.
  const gated = card && task ? decisionPost(card, task) : undefined
  // A plan posted since left the task's result behind: your reply would answer the plan.
  const left = card ? card.comments.some((c) => commentTask(c) === task && postState(c)) : false
  if (card && !gated && left)
    throw new Error(
      `task ${task}'s result on ${card.thread?.url ?? card.url} is older than the plan on ${id}:${card.key}${planThread(card)?.answer ? ': nothing of it waits' : `, which waits for your approval: approve ${id}:${card.key}`}`,
    )
  if (card && !gated)
    throw new Error(
      `${key} is a task of the plan on ${id}:${card.key}: a task takes no approval of its own, approving the plan on the card covers it`,
    )
  const target = item ?? (card || undefined)
  const post = gated ?? (target && decisionPost(target))
  if (!target || !post) throw new Error(`nothing on ${key} waits for your approval`)
  const what = post.what === 'plan' ? 'the plan' : post.what
  const on = target.thread?.url ?? target.url
  if (post.went) throw new Error(`${what} on ${on} went ahead: nothing waits for your approval`)
  if (post.answer)
    throw new Error(
      `${what} on ${on} was already answered by ${post.answer.author}, ${post.answer.at}`,
    )
  const write = { op: 'comment', body: approveReply(notes) } as const
  const threads = { forge, sources: config.sources }
  const { url = target.url } = await writeItem(source, cfg, target, write, ctx, undefined, threads)
  return `${post.what} approved: replied approve${notes.trim() ? ', with your notes,' : ''} on ${url}`
}
