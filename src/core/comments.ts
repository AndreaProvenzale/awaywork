import { posix } from 'node:path'
import { type Pin, trailingPins } from './footer.js'
import { MAX_ATTEMPTS } from './max-attempts.js'
import type { Contract } from './plan.js'
import type { Item } from './types.js'

/** The files awaywork's post pins, right above its mark. */
export const pinsOf = (c: Item['comments'][number]): Pin[] =>
  isAwayworkComment(c) ? trailingPins(rawLines(c).slice(0, -1)) : []

/** The last line of every comment awaywork writes: visible, since Jira's and Asana's rich text keep no hidden markup. */
export const commentMark = '— awaywork'

/**
 * What awaywork's post says of itself on its mark line: it waits for your answer, holding on_done's `move` from the
 * status it `saw`, or it went ahead, after the `gates` that ran clear. A plan that says neither waits.
 */
export type PostState =
  | { waits: true; move?: string; saw?: string }
  | { went: true; gates: string[] }

export const markComment = (body: string, post?: PostState): string =>
  `${body.trimEnd()}\n\n${commentMark}${post ? postMark(post) : ''}`

/** E.g. ` · waits · move=Ready%20for%20design · saw=Inbox`, each value URI-encoded so none can hold the separator. */
function postMark(post: PostState): string {
  const parts =
    'went' in post
      ? ['went ahead', ...(post.gates.length ? [`gates=${post.gates.join(',')}`] : [])]
      : ['waits', ...(post.move ? [`move=${enc(post.move)}`, `saw=${enc(post.saw ?? '')}`] : [])]
  return parts.map((part) => ` · ${part}`).join('')
}

const enc = encodeURIComponent

const markLine = (c: Item['comments'][number]): string =>
  c.body.trimEnd().split('\n').at(-1)?.trim() ?? ''

/** A comment awaywork wrote: its mark as the last line, from your own account, so a mark someone else pastes doesn't count. */
export const isAwayworkComment = (c: Item['comments'][number]): boolean =>
  !!c.mine && (markLine(c) === commentMark || markLine(c).startsWith(`${commentMark} · `))

/** What awaywork's post says of itself, if anything. */
export function postState(c: Item['comments'][number]): PostState | undefined {
  if (!isAwayworkComment(c)) return undefined
  const [, word, ...rest] = markLine(c).split(' · ')
  const value = (key: string) => {
    const found = rest.find((part) => part.startsWith(`${key}=`))?.slice(key.length + 1)
    try {
      return found === undefined ? undefined : decodeURIComponent(found)
    } catch {
      return undefined
    }
  }
  const move = value('move')
  if (word === 'waits') return { waits: true, ...(move && { move, saw: value('saw') ?? '' }) }
  if (word === 'went ahead') return { went: true, gates: value('gates')?.split(',') ?? [] }
}

const questionsAnswer =
  "Reply here to answer: awaywork's next run takes this up again with your reply."
const planAnswer =
  'To approve, reply with approve as the first line; the lines below it reach the tasks as notes. Any other reply is feedback: awaywork plans again with it.'
const planWent = 'This plan went ahead without your approve: a reply to it changes nothing.'
const reportAnswer =
  'To approve, reply with approve as the first line. Any other reply is feedback: awaywork runs this step again with it.'

/** What awaywork posts on an item when a step can't go on without answers: the step's questions, and how to answer; a task's are headed with it, on its card. */
export const questionsComment = (questions: string, task?: string): string =>
  `${task ? `${taskHeadings.questions}${task}\n\n` : ''}${questions.trim()}\n\n${questionsAnswer}`

/** The words awaywork reads from a step's `.away/out/status`. */
export type Status = 'done' | 'ask' | 'continue'

const statusLine = /^Status: ([a-z]+)(?: \((\d+) of \d+\))?$/

/** What awaywork posts on an item when its unit finished, or will go on: headed with its task or else its skill, the result, then its status, a `continue` with its count, and how to answer a post that `waits`. */
export const resultComment = (
  result: string,
  status: Status,
  skill: string,
  task?: string,
  continued = 0,
  waits = false,
): string =>
  `${task ? `${taskHeadings.result}${task}` : `${resultHeading}${skill}`}\n\n${result.trim()}\n\nStatus: ${status}${status === 'continue' ? ` (${continued} of ${MAX_ATTEMPTS})` : ''}${waits ? `\n\n${reportAnswer}` : ''}`

const resultHeading = 'Result of '

/** The status an awaywork result comment carries, e.g. `done`. */
export const resultStatus = (c: Item['comments'][number]): string | undefined => resultOf(c)?.status

/** The skill whose result awaywork posted in this comment, unless it's a task's. */
export function resultSkill(c: Item['comments'][number]): string | undefined {
  if (commentKind(c) !== 'result' || commentTask(c)) return undefined
  const first = c.body.trim().split('\n')[0]?.trim() ?? ''
  return first.startsWith(resultHeading) ? first.slice(resultHeading.length).trim() : undefined
}

/** The line awaywork's comment says its status on: above its mark, or above how to answer a post that waits. */
const statusAt = (c: Item['comments'][number]): string => {
  const lines = visibleLines(c)
  return (lines.at(-2) === reportAnswer ? lines.at(-3) : lines.at(-2)) ?? ''
}

/** An awaywork result comment's status, the times its unit said `continue` so far, and the result itself, below its heading. */
export function resultOf(
  c: Item['comments'][number],
): { status: string; continued: number; text: string } | undefined {
  const said = commentKind(c) === 'result' ? statusLine.exec(statusAt(c)) : null
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

/** What awaywork posts on an item for a `deliver: plan` rule: the report, the contract and `plan.yml` in fences, and how to answer, or that it went ahead. */
export const planComment = (
  report: string,
  plan: string,
  contract?: Contract,
  went = false,
): string =>
  `${report.trim()}\n\n${contract ? `${contractBlock(contract)}\n\n` : ''}\`\`\`yaml\n${plan.trim()}\n\`\`\`\n\n${went ? planWent : planAnswer}`

/** A lean plan post: its summary and its tasks, and how to answer, or that it went ahead; its `plan.yml`, contract and report are pinned files. */
export const leanPlanComment = (
  summary: string,
  tasks: { id: string; title: string }[],
  went = false,
): string =>
  `${summary.trim()}\n\nTasks:\n${tasks.map((t) => `- ${t.id}: ${t.title}`).join('\n')}\n\n${went ? planWent : planAnswer}`

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

/** Your first reply after awaywork's post at `at`, its answer: anyone else's comment, a bot's and awaywork's own, but the approve it posts for you, are context. */
export const answerTo = (
  item: Pick<Item, 'comments'>,
  at: number,
): Item['comments'][number] | undefined =>
  item.comments
    .slice(at + 1)
    .find((c) => c.mine && !c.bot && (!isAwayworkComment(c) || commentKind(c) === 'approve'))

export type CommentKind = 'plan' | 'questions' | 'approve' | 'result'

const rawLines = (c: Item['comments'][number]): string[] =>
  c.body
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)

/** A comment's lines as its kind and status are read: without the pins above its mark. */
const visibleLines = (c: Item['comments'][number]): string[] => {
  const lines = rawLines(c)
  const pins = trailingPins(lines.slice(0, -1)).length
  return pins ? [...lines.slice(0, -1 - pins), ...lines.slice(-1)] : lines
}

/**
 * Which of awaywork's comments this is, told by its visible text: the line above the mark, or an approve reply's first line.
 * An approve reply's notes may end in a status line, and a result never starts with `approve`: its heading is awaywork's.
 */
export function commentKind(c: Item['comments'][number]): CommentKind | undefined {
  if (!isAwayworkComment(c)) return undefined
  const above = visibleLines(c).at(-2) ?? ''
  if (above === planAnswer || above === planWent) return 'plan'
  if (above === questionsAnswer) return 'questions'
  if (isApprove(c)) return 'approve'
  return statusLine.test(statusAt(c)) ? 'result' : 'questions'
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
