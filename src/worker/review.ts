import { join } from 'node:path'
import { z } from 'zod'
import type { Forge, Review, Unit } from '../core/types.js'
import type { Outcome } from './publish.js'
import { readOutput } from './workspace.js'

const MAX_BYTES = 100_000
const MAX_COMMENTS = 100

const reviewJson = z
  .array(
    z.object({
      path: z.string().min(1),
      line: z.number().int().positive(),
      body: z.string().trim().min(1),
    }),
  )
  .max(MAX_COMMENTS)

/** The line comments in a step's `review.json`, or why they're left out; a missing one has none. */
export function parseComments(text: string): { comments: Review['comments']; invalid?: string } {
  if (!text.trim()) return { comments: [] }
  if (Buffer.byteLength(text) > MAX_BYTES)
    return { comments: [], invalid: `over ${MAX_BYTES} bytes` }
  let json: unknown
  try {
    json = JSON.parse(text)
  } catch {
    return { comments: [], invalid: 'not JSON' }
  }
  const parsed = reviewJson.safeParse(json)
  if (parsed.success) return { comments: parsed.data }
  const issue = parsed.error.issues[0]
  const at = issue?.path.length ? `${issue.path.join('.')}: ` : ''
  return { comments: [], invalid: `${at}${issue?.message}` }
}

/** The body with every line comment listed under it, for a review the forge won't take them in. */
function withComments(body: string, comments: Review['comments']): string {
  const listed = comments.map((c) => `\`${c.path}:${c.line}\`: ${c.body}`).join('\n\n')
  return `${body}\n\n## Line comments\n\n${listed}`
}

/** A reason on one line, without the `; ` that `runLine` splits a result at. */
const oneLine = (reason: string) => reason.split('\n')[0]?.split('; ')[0] ?? ''

/**
 * Leaves the chain's last report on the PR the unit reviews as your pending review at `head`, the
 * commit the clone read, with the line comments its step left in `review.json`. GitHub refuses the
 * whole review over one comment outside the PR's diff, so then they all go in the body; any other
 * failure delivers the report alone, saying why.
 */
export async function leaveReview(
  forge: Forge,
  unit: Unit,
  head: string,
  text: string,
  last: { text: string; out: string },
): Promise<Outcome> {
  const pr = unit.items
    .flatMap((i) => i.linkedPrs)
    .find((p) => p.repo === unit.repo && p.branch === unit.base)
  if (!pr) return { kind: 'report', text, unposted: 'no pull request to review' }
  try {
    const { comments, invalid } = parseComments(await readOutput(join(last.out, 'review.json')))
    const post = (review: Review) => forge.pendingReview(unit.repo, pr.number, head, review)
    const url = await post({ body: last.text, comments }).catch((e) => {
      if (!comments.length) throw e
      return post({ body: withComments(last.text, comments), comments: [] })
    })
    return {
      kind: 'review',
      url,
      text,
      ...(invalid && { note: oneLine(`review.json left out: ${invalid}`) }),
    }
  } catch (e) {
    return { kind: 'report', text, unposted: oneLine((e as Error).message) }
  }
}
