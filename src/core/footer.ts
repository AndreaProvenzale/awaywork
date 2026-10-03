import { placeholderProblem } from './branch.js'
import type { Item } from './types.js'

const marker = '<!-- night-shift'

/**
 * Appended to every PR body night-shift opens; it discloses the author, marks the PR as ours and
 * names its items, each part URI-encoded so no key can end the comment.
 */
export function footer(runId: string, items: Pick<Item, 'source' | 'key'>[]): string {
  const named = items.map(
    (i) => ` item=${encodeURIComponent(i.source)}:${encodeURIComponent(i.key)}`,
  )
  return `---\n${marker} run=${runId}${named.join('')} -->\nOpened by night-shift (run \`${runId}\`): a coding agent worked on this unattended. Review it like any other contribution.`
}

export const isOurs = (body: string | null | undefined): boolean => !!body?.includes(marker)

/** The items a night-shift PR's footer names, as `<source>:<key>`; a marker the body quotes above it doesn't count. */
export function footerItems(body: string | null | undefined): string[] {
  const line = [...(body ?? '').matchAll(/<!-- night-shift ([^<>]*)-->/g)].at(-1)?.[1] ?? ''
  return [...line.matchAll(/\bitem=([^\s:]+):(\S+)/g)].flatMap(([, source = '', key = '']) => {
    try {
      return [`${decodeURIComponent(source)}:${decodeURIComponent(key)}`]
    } catch {
      return []
    }
  })
}

/** The line a PR body carries to link an item, e.g. `Part of {key}`; `{key}`, `{id}` and `{url}` are the item's. */
export function renderLink(template: string, item: Pick<Item, 'key' | 'id' | 'url'>): string {
  return template.replace(/\{(key|id|url)\}/g, (_, name: 'key' | 'id' | 'url') => item[name])
}

/** Why a `link` template can't link a PR, or undefined when it can. */
export const linkProblem = (template: string): string | undefined =>
  placeholderProblem(template, ['key', 'id', 'url'])

/** The trailer every commit night-shift publishes carries, keyed `Night-shift: <run id>`. */
export const trailerKey = 'Night-shift'

export const hasTrailer = (message: string): boolean =>
  new RegExp(`^${trailerKey}: `, 'm').test(message)
