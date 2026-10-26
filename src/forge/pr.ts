import { readFile } from 'node:fs/promises'
import { footer, footerItems, type Status } from '../core/footer.js'
import type { CheckState, Item } from '../core/types.js'

/**
 * Whether one of my PRs is for the item: one whose footer names items by those items, whatever its
 * names; the others by the key in their branch or title, or the item's link line in their body,
 * or for Asana any URL to the task: its app writes `/0/0/<gid>`, not the permalink.
 */
export function linksItem(
  item: Item,
): (pr: { branch: string; title: string; body: string }) => boolean {
  const key = bounded(item.key)
  const link = item.link ? bounded(item.link) : undefined
  const asanaUrl =
    item.source === 'asana'
      ? new RegExp(`app\\.asana\\.com/\\S*/${escapeRegExp(item.id)}(?!\\d)`)
      : undefined
  return (pr) => {
    const items = footerItems(pr.body)
    return items.length
      ? items.includes(`${item.source}:${item.key}`)
      : key.test(pr.branch) ||
          key.test(pr.title) ||
          !!link?.test(pr.body) ||
          !!asanaUrl?.test(pr.body)
  }
}

/** The body file's first line is the title; the rest, plus the footer recording `status`, is the body. */
export async function prText(
  bodyFile: string,
  head: string,
  runId: string,
  items: Pick<Item, 'source' | 'key'>[],
  status?: Status,
): Promise<{ title: string; body: string }> {
  const [first = '', ...rest] = (await readFile(bodyFile, 'utf8')).trimStart().split('\n')
  const title = first.replace(/^#+\s*/, '').trim() || head
  return { title, body: `${rest.join('\n').trim()}\n\n${footer(runId, items, status)}` }
}

const WORSE: CheckState[] = ['passed', 'pending', 'failing']

/** Checks by name; a name reported twice takes its worse state. */
export function byName(checks: [string, CheckState][]): Record<string, CheckState> {
  const out: Record<string, CheckState> = {}
  for (const [name, state] of checks) {
    const was = out[name]
    out[name] = was && WORSE.indexOf(was) > WORSE.indexOf(state) ? was : state
  }
  return out
}

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** `text` anywhere, in any case, but not inside a longer word or number. */
const bounded = (text: string) => new RegExp(`(^|[^a-z0-9])${escapeRegExp(text)}($|[^a-z0-9])`, 'i')
