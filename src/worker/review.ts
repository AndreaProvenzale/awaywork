import { join } from 'node:path'
import { z } from 'zod'
import { slug } from '../core/foreman.js'
import type { Forge, Review, Unit } from '../core/types.js'
import type { Outcome } from './publish.js'
import { readOutput, refuseSymlinks, WORK_DIR } from './workspace.js'

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

/** The new-side lines of each file a review can comment on: those a hunk adds or keeps as context. */
export function commentableLines(diff: string): Map<string, Set<number>> {
  const files = new Map<string, Set<number>>()
  let file: Set<number> | undefined
  let line = 0
  let oldLeft = 0
  let newLeft = 0
  for (const text of diff.split('\n')) {
    // Inside a hunk, its counts tell its lines from the next file's header, whatever they hold.
    if (oldLeft > 0 || newLeft > 0) {
      if (text.startsWith('+')) {
        file?.add(line++)
        newLeft--
      } else if (text.startsWith('-')) oldLeft--
      else if (!text.startsWith('\\')) {
        file?.add(line++)
        oldLeft--
        newLeft--
      }
      continue
    }
    if (text.startsWith('diff --git ')) file = undefined
    else if (text.startsWith('+++ b/')) {
      file = new Set()
      files.set(text.slice('+++ b/'.length), file)
    }
    const hunk = /^@@ -\d+(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(text)
    if (hunk) {
      oldLeft = Number(hunk[1] ?? 1)
      line = Number(hunk[2])
      newLeft = Number(hunk[3] ?? 1)
    }
  }
  return files
}

/** A reason on one line, without the `; ` that `runLine` splits a result at. */
const oneLine = (reason: string) => reason.split('\n')[0]?.split('; ')[0] ?? ''

/**
 * Leaves the chain's last report on the PR the unit reviews as your pending review at `head`, the
 * commit the clone read, with the line comments its step left in `review.json`. A comment outside
 * the PR's diff would fail the whole review, so it goes in the body; any failure delivers the
 * report alone, saying why.
 */
export async function leaveReview(
  forge: Forge,
  unit: Unit,
  dir: string,
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
    // A PR the source only links, not an item of its own, has no diff fetched: every comment goes in the body.
    const item = unit.items.find((i) => i.type === 'pr' && i.url === pr.url)
    const diff = item && `${WORK_DIR}/context/${slug(item.key)}/diff.patch`
    if (diff) await refuseSymlinks(dir, [diff])
    const lines = commentableLines(diff ? await readOutput(join(dir, diff)) : '')
    const inDiff = comments.filter((c) => lines.get(c.path)?.has(c.line))
    const outside = comments.filter((c) => !inDiff.includes(c))
    const body = outside.length
      ? `${last.text}\n\n## Outside the diff\n\n${outside.map((c) => `\`${c.path}:${c.line}\`: ${c.body}`).join('\n\n')}`
      : last.text
    const url = await forge.pendingReview(unit.repo, pr.number, head, { body, comments: inDiff })
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
