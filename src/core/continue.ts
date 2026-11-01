import { MAX_ATTEMPTS } from './attempts.js'

export const GITHUB_ONLY = 'awaywork goes on with its own draft on GitHub only'
/** Someone else's edit could forge the footer. */
export const NOT_YOURS = 'someone else opened or edited it last'

/**
 * Why awaywork won't go on with a draft a step `left` with `continue` or `ask`, or nothing when it will: it goes on only
 * by fast-forwarding its own GitHub draft, the chain's first slice's, its head still the one awaywork left, the PR opened
 * by you and its body last edited by you (no `refused`), under `MAX_ATTEMPTS` continues. Otherwise the draft is yours.
 * Only publishing knows the `slice`: a stacked slice's footer records no status, so planning never sees one.
 */
export function byHand(
  left: { continued: number; head?: string; refused?: string },
  now: { slice?: number; head?: string } = {},
): { kind: 'waiting_for_review' | 'draft_moved' | 'continue_cap'; why: string } | undefined {
  const refused = now.slice ? "a stacked slice can't go on" : left.refused
  if (refused) return { kind: 'waiting_for_review', why: refused }
  if (left.head && now.head !== left.head)
    return {
      kind: 'draft_moved',
      why: `it moved from ${left.head.slice(0, 7)}, where awaywork left it`,
    }
  if (left.continued >= MAX_ATTEMPTS)
    return { kind: 'continue_cap', why: `it continued ${left.continued} times` }
}
