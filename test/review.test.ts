import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { Unit } from '../src/core/types.js'
import { leaveReview, parseComments } from '../src/worker/review.js'
import { fakeForge } from './fakes/forge.js'
import { githubPr } from './fakes/items.js'

describe('parseComments', () => {
  it('takes path, line and body, and says why it left a file out; a missing one has none', () => {
    const comment = { path: 'src/a.ts', line: 3, body: 'Name it after what it holds.' }
    expect(parseComments(JSON.stringify([{ ...comment, side: 'RIGHT' }]))).toEqual({
      comments: [comment],
    })
    expect(parseComments('')).toEqual({ comments: [] })
    expect(parseComments('[{')).toEqual({ comments: [], invalid: 'not JSON' })
    expect(parseComments(JSON.stringify({ comments: [comment] })).invalid).toMatch(/expected array/)
    expect(parseComments(JSON.stringify([{ ...comment, line: '3' }])).invalid).toMatch(/^0\.line: /)
    expect(parseComments(JSON.stringify([{ ...comment, line: 0 }])).invalid).toMatch(/^0\.line: /)
    expect(parseComments(JSON.stringify([{ ...comment, body: ' ' }])).invalid).toMatch(/^0\.body: /)
    expect(parseComments(JSON.stringify(Array(101).fill(comment))).invalid).toMatch(/100/)
    const big = JSON.stringify([{ ...comment, body: 'x'.repeat(100_001) }])
    expect(parseComments(big)).toEqual({ comments: [], invalid: 'over 100000 bytes' })
  })
})

describe('leaveReview', () => {
  /** The review step's `out/` holding `review`. */
  async function setUp(review?: string) {
    const out = await mkdtemp(join(tmpdir(), 'awaywork-review-'))
    if (review !== undefined) await writeFile(join(out, 'review.json'), review)
    const unit = { repo: 'acme/api', base: 'feature-1', items: [githubPr(1, { mine: false })] }
    return { out, unit: unit as Unit }
  }

  const comments = [
    { path: 'a.ts', line: 2, body: 'Why two?' },
    { path: 'a.ts', line: 9, body: 'Far from the diff.' },
  ]

  it('posts the last report with its line comments at the given commit', async () => {
    const { out, unit } = await setUp(JSON.stringify(comments))
    const forge = fakeForge()
    const outcome = await leaveReview(forge, unit, 'abc1234', 'All of it', {
      text: 'Looks fine.',
      out,
    })
    expect(outcome).toEqual({
      kind: 'review',
      url: 'https://example.com/acme/api/pull/1#pullrequestreview-1',
      text: 'All of it',
    })
    expect(forge.reviews).toEqual([
      { repo: 'acme/api', pr: 1, head: 'abc1234', body: 'Looks fine.', comments },
    ])
  })

  it('posts the body alone with a note when review.json is invalid, and nothing extra when there is none', async () => {
    const invalid = await setUp('{"path": "a.ts"}')
    const forge = fakeForge()
    const last = { text: 'Looks fine.', out: invalid.out }
    expect(await leaveReview(forge, invalid.unit, 'abc', 'x', last)).toMatchObject({
      kind: 'review',
      note: 'review.json left out: Invalid input: expected array, received object',
    })
    const none = await setUp()
    const plain = await leaveReview(forge, none.unit, 'abc', 'x', { ...last, out: none.out })
    expect(plain).not.toHaveProperty('note')
    expect(forge.reviews.map((r) => [r.body, r.comments])).toEqual([
      ['Looks fine.', []],
      ['Looks fine.', []],
    ])
  })

  it('folds every comment into the body when the forge refuses its line comments', async () => {
    const { out, unit } = await setUp(JSON.stringify(comments))
    const forge = fakeForge()
    const post = forge.pendingReview
    forge.pendingReview = async (repo, pr, head, review) => {
      if (review.comments.length)
        throw new Error('Unprocessable Entity: Line could not be resolved')
      return post(repo, pr, head, review)
    }
    const outcome = await leaveReview(forge, unit, 'abc', 'x', { text: 'Fine.', out })
    expect(outcome).toMatchObject({ kind: 'review' })
    expect(forge.reviews.map((r) => [r.body, r.comments])).toEqual([
      ['Fine.\n\n## Line comments\n\n`a.ts:2`: Why two?\n\n`a.ts:9`: Far from the diff.', []],
    ])
  })

  it('delivers the report alone, saying why, when the forge refuses it or there is no PR', async () => {
    const { out, unit } = await setUp(JSON.stringify(comments))
    const forge = fakeForge()
    let posts = 0
    forge.pendingReview = async () => {
      posts++
      throw new Error(
        'Unprocessable Entity: User can only have one pending review per pull request\nmore',
      )
    }
    expect(await leaveReview(forge, unit, 'abc', 'Report', { text: 'r', out })).toEqual({
      kind: 'report',
      text: 'Report',
      unposted: 'Unprocessable Entity: User can only have one pending review per pull request',
    })
    expect(posts).toBe(2)
    const elsewhere = { ...unit, base: 'feature-9' }
    expect(await leaveReview(fakeForge(), elsewhere, 'abc', 'Report', { text: 'r', out })).toEqual({
      kind: 'report',
      text: 'Report',
      unposted: 'no pull request to review',
    })
  })
})
