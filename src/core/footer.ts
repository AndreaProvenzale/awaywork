import { placeholderProblem } from './branch.js'
import type { Item } from './types.js'

const marker = '<!-- awaywork'

/**
 * Appended to every PR body awaywork opens; it discloses the author, marks the PR as ours and
 * names its items, each part URI-encoded so no key can end the comment.
 */
export function footer(runId: string, items: Pick<Item, 'source' | 'key'>[]): string {
  const named = items.map(
    (i) => ` item=${encodeURIComponent(i.source)}:${encodeURIComponent(i.key)}`,
  )
  return `---\n${marker} run=${runId}${named.join('')} -->\nOpened by awaywork (run \`${runId}\`): a coding agent worked on this unattended. Review it like any other contribution.`
}

export const isOurs = (body: string | null | undefined): boolean => !!body?.includes(marker)

/** The items an awaywork PR's footer names, as `<source>:<key>`; a marker the body quotes above it doesn't count. */
export function footerItems(body: string | null | undefined): string[] {
  const line = [...(body ?? '').matchAll(/<!-- awaywork ([^<>]*)-->/g)].at(-1)?.[1] ?? ''
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

/** The trailer every commit awaywork publishes carries, keyed `Awaywork: <run id>`. */
export const trailerKey = 'Awaywork'

export const hasTrailer = (message: string): boolean =>
  new RegExp(`^${trailerKey}: `, 'm').test(message)

/** The last line of every comment awaywork writes: visible, since Jira's and Asana's rich text keep no hidden markup. */
export const commentMark = '— awaywork'

export const markComment = (body: string): string => `${body.trimEnd()}\n\n${commentMark}`

/** A comment awaywork wrote: its mark as the last line, from your own account, so a mark someone else pastes doesn't count. */
export const isAwayworkComment = (c: Item['comments'][number]): boolean =>
  !!c.mine && c.body.trimEnd().split('\n').at(-1)?.trim() === commentMark

const questionsAnswer =
  "Reply here to answer: awaywork's next run takes this up again with your reply."
const planAnswer =
  'To approve, reply with approve as the first line; the lines below it reach the tasks as notes. Any other reply is feedback: awaywork plans again with it.'

/** What awaywork posts on an item when a step can't go on without answers: the step's questions, and how to answer. */
export const questionsComment = (questions: string): string =>
  `${questions.trim()}\n\n${questionsAnswer}`

/** What awaywork posts on an item for a `deliver: plan` rule: the report, `plan.yml` in a fence, and how to answer. */
export const planComment = (report: string, plan: string): string =>
  `${report.trim()}\n\n\`\`\`yaml\n${plan.trim()}\n\`\`\`\n\n${planAnswer}`

/** The reply that approves a plan: `approve`, then the notes for its tasks. */
export const approveReply = (notes: string): string =>
  notes.trim() ? `approve\n${notes.trim()}` : 'approve'

/** Your comment whose first line is `approve`: awaywork's own reply for you counts too. */
export const isApprove = (c: Item['comments'][number]): boolean =>
  !!c.mine && c.body.trim().split('\n')[0]?.trim().toLowerCase() === 'approve'

export type CommentKind = 'plan' | 'questions' | 'approve'

/** Which of awaywork's comments this is, told by its visible text: the line above the mark, or an approve reply's first line. */
export function commentKind(c: Item['comments'][number]): CommentKind | undefined {
  if (!isAwayworkComment(c)) return undefined
  const lines = c.body
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
  if (lines.at(-2) === planAnswer) return 'plan'
  if (lines.at(-2) !== questionsAnswer && isApprove(c)) return 'approve'
  return 'questions'
}

/** Awaywork's questions are the item's newest comment but a bot's: it waits for an answer, from you or anyone its source trusts. */
export const awaitsAnswer = (item: Pick<Item, 'comments'>): boolean => {
  const newest = item.comments.filter((c) => !c.bot).at(-1)
  return !!newest && commentKind(newest) === 'questions'
}

const headings = { plan: "awaywork's plan", questions: "awaywork's questions" }

/** A comment as `item.md` shows it, awaywork's plan and questions headed as such, its approve reply as yours. */
export function commentMarkdown(c: Item['comments'][number]): string {
  const kind = commentKind(c)
  const who = kind && kind !== 'approve' ? `${headings[kind]} (${c.author})` : c.author
  return `\n### ${who}, ${c.at}\n\n${c.body}\n`
}
