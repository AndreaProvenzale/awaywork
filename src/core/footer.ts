import { placeholderProblem } from './branch.js'
import type { Item } from './types.js'

const marker = '<!-- awaywork'

/**
 * Appended to every PR body awaywork opens; it discloses the author, marks the PR as ours and
 * names its items, each part URI-encoded so no key can end the comment, and what a draft `left` for a later run, if anything.
 */
export function footer(
  runId: string,
  items: Pick<Item, 'source' | 'key'>[],
  left?: Left,
  pins: Pin[] = [],
): string {
  const named = items.map(
    (i) => ` item=${encodeURIComponent(i.source)}:${encodeURIComponent(i.key)}`,
  )
  const said = left
    ? ` status=${left.status} continued=${left.continued} head=${left.head} from=${left.from}`
    : ''
  return `---\n${marker} run=${runId}${named.join('')}${said} -->\nOpened by awaywork (run \`${runId}\`): a coding agent worked on this unattended. Review it like any other contribution.${pinBlock(pins)}`
}

/** A file awaywork put in the store for a post: its name under `.away/out/`, its URL, and its size and sha256 when put. */
export interface Pin {
  name: string
  url: string
  sha256: string
  /** Bytes; a pin line written before awaywork wrote sizes has none. */
  size?: number
}

/** E.g. `Pinned plan.yml: https://… (1234 bytes, sha256 9f86…)`, the name URI-encoded but for its slashes, so a space can't split the line. */
const pinLine = ({ name, url, sha256, size }: Pin): string =>
  `Pinned ${encodeURIComponent(name).replaceAll('%2F', '/')}: ${url} (${size === undefined ? '' : `${size} bytes, `}sha256 ${sha256})`

/** The pins' lines, a paragraph after what they follow; '' for none. */
export const pinBlock = (pins: Pin[]): string =>
  pins.length ? `\n\n${pins.map(pinLine).join('\n')}` : ''

function readPin(line: string | undefined): Pin | undefined {
  const [, name = '', url = '', size, sha256 = ''] =
    /^Pinned (\S+): (\S+) \((?:(\d+) bytes, )?sha256 ([0-9a-f]{64})\)$/.exec(line?.trim() ?? '') ??
    []
  try {
    return name
      ? { name: decodeURIComponent(name), url, sha256, ...(size && { size: Number(size) }) }
      : undefined
  } catch {
    return undefined
  }
}

/** The pins at the end of `lines`, in order: awaywork writes them after anything a model wrote. */
export function trailingPins(lines: string[]): Pin[] {
  const pins: Pin[] = []
  for (let at = lines.length - 1; at >= 0; at--) {
    const pin = readPin(lines[at])
    if (!pin) break
    pins.unshift(pin)
  }
  return pins
}

/** The files an awaywork PR's footer pins: only below its last marker, which the PR body above can't follow. */
export const footerPins = (body: string | null | undefined): Pin[] => {
  const at = (body ?? '').lastIndexOf(marker)
  return at < 0
    ? []
    : trailingPins(
        (body ?? '')
          .slice(at)
          .split('\n')
          .filter((l) => l.trim()),
      )
}

export const isOurs = (body: string | null | undefined): boolean => !!body?.includes(marker)

/** The last marker line's contents: the footer's, since a marker the body quotes above it doesn't count. */
const footerLine = (body: string | null | undefined): string =>
  [...(body ?? '').matchAll(/<!-- awaywork ([^<>]*)-->/g)].at(-1)?.[1] ?? ''

/** The last line of a thread issue's body: the item it's awaywork's thread of, each part URI-encoded as in a PR's footer. */
export const threadMarker = (item: Pick<Item, 'source' | 'key'>): string =>
  `${marker} thread item=${encodeURIComponent(item.source)}:${encodeURIComponent(item.key)} -->`

/** The item (`<source>:<key>`) an issue's body says it's awaywork's thread of. */
export const threadOf = (body: string | null | undefined): string | undefined =>
  footerLine(body).startsWith('thread ') ? footerItems(body)[0] : undefined

/** The body of the issue awaywork opens as an item's thread. */
export const threadBody = (item: Pick<Item, 'source' | 'key' | 'title' | 'url'>): string =>
  `awaywork posts here for [${item.key}](${item.url}), ${item.title}: its plans, results and questions. Reply here to answer them; the card still decides whether it's yours.\n\n${threadMarker(item)}`

/** The items an awaywork PR's footer names, as `<source>:<key>`. */
export function footerItems(body: string | null | undefined): string[] {
  return [...footerLine(body).matchAll(/\bitem=([^\s:]+):(\S+)/g)].flatMap(
    ([, source = '', key = '']) => {
      try {
        return [`${decodeURIComponent(source)}:${decodeURIComponent(key)}`]
      } catch {
        return []
      }
    },
  )
}

/**
 * What awaywork's draft left for a later run: the status its step said, the times the unit said `continue` so far,
 * the head awaywork pushed and the commit its own commits start after.
 */
export interface Left {
  status: 'ask' | 'continue'
  continued: number
  head: string
  from: string
}

/** What an awaywork PR's footer says it left, if anything: the body's visible status line is for people, and the model could write one. */
export function footerLeft(body: string | null | undefined): Left | undefined {
  const line = footerLine(body)
  const value = (key: string) => new RegExp(`\\b${key}=(\\S+)`).exec(line)?.[1]
  const status = value('status')
  const [head, from] = [value('head'), value('from')]
  if ((status !== 'ask' && status !== 'continue') || !head || !from) return undefined
  return { status, continued: Number(value('continued')) || 0, head, from }
}

/** What an open draft's footer says awaywork left, the items it names, and why awaywork won't go on with it, if it won't. */
export type DraftLeft = Left & { items: string[]; refused?: string }

/**
 * A PR's `left`, for its ref, while it's still a draft whose footer says it left anything: one you marked ready is yours.
 * It holds dependents back from anyone's footer; `refused` says why awaywork won't push onto it.
 */
export const leftIn = (
  body: string | null | undefined,
  draft: boolean,
  refused?: string,
): { left?: DraftLeft } => {
  const left = draft ? footerLeft(body) : undefined
  return left ? { left: { ...left, items: footerItems(body), ...(refused && { refused }) } } : {}
}

/** The line a PR body carries to link an item, e.g. `Part of {key}`; `{key}`, `{id}` and `{url}` are the item's. */
export function renderLink(template: string, item: Pick<Item, 'key' | 'id' | 'url'>): string {
  return template.replace(/\{(key|id|url)\}/g, (_, name: 'key' | 'id' | 'url') => item[name])
}

/** Why a `link` template can't link a PR, or undefined when it can. */
export const linkProblem = (template: string): string | undefined =>
  placeholderProblem(template, ['key', 'id', 'url'])

/** The trailer every commit awaywork publishes carries, keyed `Awaywork: <run id>`. */
export const trailerKey = 'Awaywork'

export const hasTrailer = (message: string): boolean =>
  new RegExp(`^${trailerKey}: `, 'm').test(message)
