import {
  answerTo,
  commentKind,
  commentTask,
  isApprove,
  isAwayworkComment,
  type PostState,
  pinsOf,
  postState,
  resultOf,
  resultSkill,
  resultStatus,
} from './comments.js'
import { footerPins, type Pin } from './footer.js'
import { planThread } from './plan.js'
import type { Item } from './types.js'

type Comment = Item['comments'][number]

/** Awaywork's post of a result that says it waits or went ahead, and its answer: your first reply after it, or the post itself when it went ahead. */
export interface Post {
  post: Comment
  state: PostState
  answer?: Comment
}

/** The post at `at` when it says it waits or went ahead. */
function postAt(item: Pick<Item, 'comments'>, at: number): Post | undefined {
  const post = item.comments[at]
  const state = post && postState(post)
  if (!post || !state) return undefined
  const answer = 'went' in state ? post : answerTo(item, at)
  return { post, state, ...(answer && { answer }) }
}

/** A report rule's newest post on the item, the result of its `skill`, when it says it waits or went ahead. */
export function reportPost(item: Pick<Item, 'comments'>, skill: string): Post | undefined {
  return postAt(
    item,
    item.comments.findLastIndex((c) => resultSkill(c) === skill),
  )
}

/** Where a post stands: waiting for your answer, your feedback, or approved, by your `approve` or by going ahead; a file of it edited in the store is feedback. */
export const postAnswer = ({ post, state, answer }: Post): 'waiting' | 'feedback' | 'approved' =>
  post.pinned?.stale
    ? 'feedback'
    : !answer
      ? 'waiting'
      : 'went' in state || isApprove(answer)
        ? 'approved'
        : 'feedback'

/** Where the results of a plan's tasks start on the card: after its approval, a re-plan's leaving older ones behind. */
function tasksFrom(item: Pick<Item, 'comments'>): number {
  const answer = planThread(item)?.answer
  return answer ? item.comments.indexOf(answer) + 1 : item.comments.length
}

/** Each task's newest result on the card since its plan's approval, and its post when it says it waits or went ahead. */
function taskPosts(item: Pick<Item, 'comments'>): Map<string, { result: Comment; post?: Post }> {
  const from = tasksFrom(item)
  const newest = new Map<string, { result: Comment; post?: Post }>()
  item.comments.forEach((c, at) => {
    const task = at >= from && commentKind(c) === 'result' ? commentTask(c) : undefined
    const post = postAt(item, at)
    if (task) newest.set(task, { result: c, ...(post && { post }) })
  })
  return newest
}

/**
 * Where each task's newest `done` result on the card stands since its plan's approval:
 * `approved` is done, a plain result too; one a gate fired on is `waiting` for your answer, or runs again on your `feedback`.
 */
export function taskResults(
  item: Pick<Item, 'comments'>,
): Record<string, ReturnType<typeof postAnswer> | undefined> {
  const results: ReturnType<typeof taskResults> = {}
  for (const [task, { result, post }] of taskPosts(item)) {
    const done = resultStatus(result) === 'done'
    results[task] = !done ? undefined : post ? postAnswer(post) : 'approved'
  }
  return results
}

/** Why a task's result on the card decides nothing yet: awaywork couldn't read its pinned files back. */
export const unreadTaskResult = (item: Pick<Item, 'comments'>): string | undefined =>
  decisionPosts(item).find((c) => commentTask(c) && c.pinned?.failed)?.pinned?.failed

/** The skill of the newest result awaywork posted on the item that you approved or that went ahead: the item's `approved`. */
export function approvedSkill(item: Pick<Item, 'comments'>): string | undefined {
  for (let at = item.comments.length - 1; at >= 0; at--) {
    const skill = resultSkill(item.comments[at] as Comment)
    const post = skill && postAt(item, at)
    if (post && postAnswer(post) === 'approved') return skill
  }
}

/** The item with its `approved` field read off its thread. */
export const withApproved = (item: Item): Item => {
  const approved = approvedSkill(item)
  return approved ? { ...item, fields: { ...item.fields, approved } } : item
}

/**
 * The move on_done held on awaywork's newest post on the item, once you approved it: only while the card is
 * still in the status the post saw and the move isn't applied yet, as a GitHub label shows it.
 */
export function heldMove(item: Pick<Item, 'comments' | 'status' | 'labels'>): string | undefined {
  const at = item.comments.findLastIndex(
    (c) => isAwayworkComment(c) && commentKind(c) !== 'approve',
  )
  const post = postAt(item, at)
  if (!post || !('waits' in post.state) || postAnswer(post) !== 'approved') return undefined
  const { move, saw } = post.state
  return move && item.status === saw && !item.labels.includes(move) ? move : undefined
}

/** Awaywork's newest post on the item that waits or waited for your decision: a plan, or a result that says so; with `task`, that task's result on its card since the plan's approval. */
export function decisionPost(
  item: Pick<Item, 'comments'>,
  task?: string,
): { what: string; post: Comment; answer?: Comment; went?: true } | undefined {
  const plan = task ? undefined : planThread(item)
  const from = task ? tasksFrom(item) : 0
  const at = item.comments.findLastIndex(
    (c, i) =>
      i >= from &&
      commentKind(c) === 'result' &&
      !!postState(c) &&
      (!task || commentTask(c) === task),
  )
  const report = postAt(item, at)
  const planAt = plan ? item.comments.indexOf(plan.plan) : -1
  if (plan && planAt > at) return { what: 'plan', ...plan, post: plan.plan }
  if (!report) return undefined
  const of = commentTask(report.post)
  const what = of ? `task ${of}'s result` : `${resultSkill(report.post)}'s result`
  return { what, ...report, ...('went' in report.state && { went: true as const }) }
}

/** The posts on the item whose answer decides a rule: the newest plan, and each skill's and each task's newest result that waits or went ahead. */
export function decisionPosts(item: Pick<Item, 'comments'>): Comment[] {
  const plan = planThread(item)?.plan
  const skills = new Set(item.comments.flatMap((c) => resultSkill(c) ?? []))
  const reports = [...skills].flatMap((skill) => reportPost(item, skill)?.post ?? [])
  const tasks = [...taskPosts(item).values()].flatMap((r) => r.post?.post ?? [])
  return [...(plan ? [plan] : []), ...reports, ...tasks]
}

/** A post whose pinned files a unit reads back: its folder's name under `files/`, what it is, its pins, whether a file edited since is your feedback, else left out, and whether the unit can't go without it. */
export interface PinnedPost {
  name: string
  what: string
  pins: Pin[]
  edits: boolean
  needed: boolean
}

/**
 * The posts whose files a unit of `skill` on the item reads back: the post its approval covers (a task's plan, the result
 * `approved` names), its own newest post when it runs again on your feedback, those newer than that post, and the body of
 * a PR awaywork opened for you.
 */
export function readBackPosts(item: Item, skill: string, plan: boolean): PinnedPost[] {
  const task = item.task?.id
  const own = item.comments.findLastIndex((c) =>
    task
      ? commentKind(c) === 'result' && commentTask(c) === task
      : plan
        ? commentKind(c) === 'plan'
        : resultSkill(c) === skill,
  )
  const covered = task
    ? planThread(item)?.plan
    : item.comments.findLast((c, at) => {
        // A plan has no skill: it mustn't match an item with no `approved`.
        const result = resultSkill(c)
        const post = result && result === item.fields.approved && postAt(item, at)
        return !!post && postAnswer(post) === 'approved'
      })
  const ownPost = item.comments[own]
  // It runs again on your feedback, or goes on from where it said `continue`.
  const again =
    ownPost &&
    (commentKind(ownPost) === 'plan' ||
      !!postState(ownPost) ||
      resultOf(ownPost)?.status === 'continue')
  const posts = item.comments.flatMap((c, at) => {
    const pins = pinsOf(c)
    const read = c === covered || at > own || (at === own && again)
    if (!pins.length || !read || commentKind(c) === 'approve') return []
    const of = commentTask(c)
    const kind =
      commentKind(c) === 'plan' ? 'plan' : (resultSkill(c) ?? (of ? `task-${of}` : 'post'))
    return [
      {
        // The kind is the post's heading, which a teammate may have edited: one path segment, whatever it says.
        name: `${at + 1}-${kind.replace(/[^a-z0-9._-]+/gi, '-').slice(0, 64)}`,
        what: `awaywork's post of ${c.at}`,
        pins,
        edits: !!item.mine,
        needed: c === covered || (at === own && !!again),
      },
    ]
  })
  // Only a PR awaywork opened for you, its body last edited by you: anyone can end a PR body with awaywork's marker and a pin.
  const ours = item.type === 'pr' && item.mine && item.bodyMine && item.fields.ours === true
  const body = ours ? footerPins(item.description) : []
  const footer = {
    name: 'pr',
    what: "the PR body's footer",
    pins: body,
    edits: false,
    needed: true,
  }
  return body.length ? [...posts, footer] : posts
}
