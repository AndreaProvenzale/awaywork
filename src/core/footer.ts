import { posix } from 'node:path'
import { MAX_ATTEMPTS } from './attempts.js'
import { placeholderProblem } from './branch.js'
import type { Contract } from './plan.js'
import type { Item } from './types.js'

const marker = '<!-- awaywork'

/**
 * Appended to every PR body awaywork opens; it discloses the author, marks the PR as ours and
 * names its items, each part URI-encoded so no key can end the comment, and what a draft `left` for a later run, if anything.
 */
export function footer(runId: string, items: Pick<Item, 'source' | 'key'>[], left?: Left): string {
  const named = items.map(
    (i) => ` item=${encodeURIComponent(i.source)}:${encodeURIComponent(i.key)}`,
  )
  const said = left
    ? ` status=${left.status} continued=${left.continued} head=${left.head} from=${left.from}`
    : ''
  return `---\n${marker} run=${runId}${named.join('')}${said} -->\nOpened by awaywork (run \`${runId}\`): a coding agent worked on this unattended. Review it like any other contribution.`
}

export const isOurs = (body: string | null | undefined): boolean => !!body?.includes(marker)

/** The last marker line's contents: the footer's, since a marker the body quotes above it doesn't count. */
const footerLine = (body: string | null | undefined): string =>
  [...(body ?? '').matchAll(/<!-- awaywork ([^<>]*)-->/g)].at(-1)?.[1] ?? ''

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

/**
 * A PR's `left`, with the items its footer names, for its ref, when it's still a draft whose footer says it left anything
 * and whose body is yours: one you marked ready is yours to finish, and someone else's edit could forge the footer.
 */
export const leftIn = (
  body: string | null | undefined,
  draft: boolean,
  bodyYours: boolean,
): { left?: Left & { items: string[] } } => {
  const left = draft && bodyYours ? footerLeft(body) : undefined
  return left ? { left: { ...left, items: footerItems(body) } } : {}
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

/** What awaywork posts on an item when a step can't go on without answers: the step's questions, and how to answer; a task's are headed with it, on its card. */
export const questionsComment = (questions: string, task?: string): string =>
  `${task ? `${taskHeadings.questions}${task}\n\n` : ''}${questions.trim()}\n\n${questionsAnswer}`

/** The words awaywork reads from a step's `.away/out/status`. */
export type Status = 'done' | 'ask' | 'continue'

const statusLine = /^Status: ([a-z]+)(?: \((\d+) of \d+\))?$/

/** What awaywork posts on an item when its unit finished, or will go on: headed with its task or else its skill, the result, then its status, a `continue` with its count. */
export const resultComment = (
  result: string,
  status: Status,
  skill: string,
  task?: string,
  continued = 0,
): string =>
  `${task ? `${taskHeadings.result}${task}` : `Result of ${skill}`}\n\n${result.trim()}\n\nStatus: ${status}${status === 'continue' ? ` (${continued} of ${MAX_ATTEMPTS})` : ''}`

/** The status an awaywork result comment carries, e.g. `done`. */
export const resultStatus = (c: Item['comments'][number]): string | undefined => resultOf(c)?.status

/** An awaywork result comment's status, the times its unit said `continue` so far, and the result itself, below its heading. */
export function resultOf(
  c: Item['comments'][number],
): { status: string; continued: number; text: string } | undefined {
  const said = commentKind(c) === 'result' ? statusLine.exec(visibleLines(c).at(-2) ?? '') : null
  if (!said?.[1]) return undefined
  const lines = c.body.trim().split('\n')
  const text = lines.slice(
    1,
    lines.findLastIndex((line) => statusLine.test(line.trim())),
  )
  return { status: said[1], continued: Number(said[2]) || 0, text: text.join('\n').trim() }
}

const taskHeadings = { questions: 'Questions from task ', result: 'Result of task ' }

/** The task whose questions or result awaywork posted in this comment on its card, if they are a task's: a result's heading is always awaywork's. */
export function commentTask(c: Item['comments'][number]): string | undefined {
  const kind = commentKind(c)
  if (kind !== 'questions' && kind !== 'result') return undefined
  const first = c.body.trim().split('\n')[0]?.trim() ?? ''
  const heading = taskHeadings[kind]
  return first.startsWith(heading) ? first.slice(heading.length).trim() : undefined
}

/** The tasks whose questions on the card wait: those after its last comment that's neither a bot's nor awaywork's, which answers every one above it. */
export function waitingTasks(item: Pick<Item, 'comments'>): string[] {
  const answered = item.comments.findLastIndex((c) => !c.bot && !isAwayworkComment(c))
  const asked = item.comments
    .slice(answered + 1)
    .flatMap((c) => (commentKind(c) === 'questions' && commentTask(c)) || [])
  return [...new Set(asked)]
}

/** What awaywork posts on an item for a `deliver: plan` rule: the report, the contract and `plan.yml` in fences, and how to answer. */
export const planComment = (report: string, plan: string, contract?: Contract): string =>
  `${report.trim()}\n\n${contract ? `${contractBlock(contract)}\n\n` : ''}\`\`\`yaml\n${plan.trim()}\n\`\`\`\n\n${planAnswer}`

export const contractHeading = (name: string) => `### Contract: ${name}`

/** The contract under its heading, in a fence longer than any run of backticks in it. */
function contractBlock({ name, text }: Contract): string {
  const longest = Math.max(0, ...[...text.matchAll(/`+/g)].map(([run]) => run.length))
  const fence = '`'.repeat(Math.max(3, longest + 1))
  return `${contractHeading(name)}\n\n${fence}${posix.extname(name).slice(1)}\n${text}\n${fence}`
}

/** The reply that approves a plan: `approve`, then the notes for its tasks. */
export const approveReply = (notes: string): string =>
  notes.trim() ? `approve\n${notes.trim()}` : 'approve'

/** Your comment whose first line is `approve`: awaywork's own reply for you counts too. */
export const isApprove = (c: Item['comments'][number]): boolean =>
  !!c.mine && c.body.trim().split('\n')[0]?.trim().toLowerCase() === 'approve'

export type CommentKind = 'plan' | 'questions' | 'approve' | 'result'

const visibleLines = (c: Item['comments'][number]): string[] =>
  c.body
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)

/**
 * Which of awaywork's comments this is, told by its visible text: the line above the mark, or an approve reply's first line.
 * An approve reply's notes may end in a status line, and a result never starts with `approve`: its heading is awaywork's.
 */
export function commentKind(c: Item['comments'][number]): CommentKind | undefined {
  if (!isAwayworkComment(c)) return undefined
  const above = visibleLines(c).at(-2) ?? ''
  if (above === planAnswer) return 'plan'
  if (above === questionsAnswer) return 'questions'
  if (isApprove(c)) return 'approve'
  return statusLine.test(above) ? 'result' : 'questions'
}

/** Awaywork's questions are the item's newest comment but a bot's or awaywork's result: it waits for an answer, from you or anyone its source trusts. */
export const awaitsAnswer = (item: Pick<Item, 'comments'>): boolean => {
  const newest = item.comments.filter((c) => !c.bot && commentKind(c) !== 'result').at(-1)
  return !!newest && commentKind(newest) === 'questions'
}

const headings = {
  plan: "awaywork's plan",
  questions: "awaywork's questions",
  result: "awaywork's result",
}

/** A comment as `item.md` shows it, awaywork's plan, questions and result headed as such, a task's by the task, its approve reply as yours. */
export function commentMarkdown(c: Item['comments'][number]): string {
  const kind = commentKind(c)
  const task = commentTask(c)
  const of = kind === 'result' ? 'of' : 'from'
  const heading =
    kind && kind !== 'approve' && `${headings[kind]}${task ? ` ${of} task ${task}` : ''}`
  const who = heading ? `${heading} (${c.author})` : c.author
  return `\n### ${who}, ${c.at}\n\n${c.body}\n`
}
