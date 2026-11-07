import type { Command } from 'commander'
import { configPath, loadConfig } from '../config/load.js'
import type { Config } from '../config/schema.js'
import { approveReply } from '../core/footer.js'
import { cardTasks, planThread } from '../core/plan.js'
import { decisionPost } from '../core/posts.js'
import type { Ctx, Forge, Source } from '../core/types.js'
import { forgeFor } from '../forge/index.js'
import { sourceFor, writeItem } from '../sources/index.js'
import { linkThreads, threadSources } from './plan.js'
import { checkKey, printOutcome } from './skip.js'

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
  const threads = threadSources(config)
  checkKey(key, [...Object.keys(config.sources), ...(threads.length ? ['github'] : [])])
  const read = async (id: string) => {
    const cfg = config.sources[id]
    const source = cfg ? (sources[id] ?? sourceFor(id, cfg)) : undefined
    const items = source ? await source.items(cfg, ctx) : []
    return { cfg, source, items: await linkThreads(items, config, forge, ctx) }
  }
  // A thread issue isn't a GitHub item: its key names the card it's the thread of.
  const thread = async () => {
    for (const other of new Set(threads)) {
      const found = await read(other)
      const card = found.items.find(
        (i) => i.thread && `github:${i.thread.repo}#${i.thread.number}` === key,
      )
      if (card) return { ...found, item: card }
    }
  }
  const id = key.slice(0, key.indexOf(':'))
  const named = await read(id)
  const own = named.items.find((i) => `${id}:${i.key}` === key)
  const { cfg, source, items, item } = (!own && key.startsWith('github:') && (await thread())) || {
    ...named,
    item: own,
  }
  const card = !item && items.find((i) => key.startsWith(`${id}:${i.key}/`) && planThread(i))
  const task = card && key.slice(`${id}:${card.key}/`.length)
  if (card && !cardTasks(card).some((t) => t.id === task))
    throw new Error(`the plan on ${id}:${card.key} has no task ${task}`)
  if (card)
    throw new Error(
      `${key} is a task of the plan on ${id}:${card.key}: a task takes no approval of its own, approving the plan on the card covers it`,
    )
  const post = item && decisionPost(item)
  if (!item || !post) throw new Error(`nothing on ${key} waits for your approval`)
  const what = post.what === 'plan' ? 'the plan' : post.what
  if (post.went)
    throw new Error(`${what} on ${item.url} went ahead: nothing waits for your approval`)
  if (post.answer)
    throw new Error(
      `${what} on ${item.url} was already answered by ${post.answer.author}, ${post.answer.at}`,
    )
  const write = { op: 'comment', body: approveReply(notes) } as const
  const { url = item.url } = await writeItem(source, cfg, item, write, ctx, undefined, { forge })
  return `${post.what} approved: replied approve${notes.trim() ? ', with your notes,' : ''} on ${url}`
}
