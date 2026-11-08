import {
  answerTo,
  commentKind,
  isApprove,
  isAwayworkComment,
  type PostState,
  postState,
  resultSkill,
} from './footer.js'
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

/** Where a post stands: waiting for your answer, your feedback, or approved, by your `approve` or by going ahead. */
export const postAnswer = ({ state, answer }: Post): 'waiting' | 'feedback' | 'approved' =>
  !answer ? 'waiting' : 'went' in state || isApprove(answer) ? 'approved' : 'feedback'

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

/** Awaywork's newest post on the item that waits or waited for your decision: a plan, or a result that says so. */
export function decisionPost(
  item: Pick<Item, 'comments'>,
): { what: string; post: Comment; answer?: Comment; went?: true } | undefined {
  const plan = planThread(item)
  const at = item.comments.findLastIndex((c) => !!resultSkill(c) && !!postState(c))
  const report = postAt(item, at)
  const planAt = plan ? item.comments.indexOf(plan.plan) : -1
  if (plan && planAt > at) return { what: 'plan', ...plan, post: plan.plan }
  if (!report) return undefined
  const what = `${resultSkill(report.post)}'s result`
  return { what, ...report, ...('went' in report.state && { went: true as const }) }
}
