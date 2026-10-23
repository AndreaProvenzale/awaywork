import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { PendingReviewExists, type Unit } from '../src/core/types.js'
import { commentableLines, leaveReview, parseComments } from '../src/worker/review.js'
import { fakeForge } from './fakes/forge.js'
import { fixture } from './fakes/gh.js'
import { githubPr } from './fakes/items.js'

describe('commentableLines', () => {
  it("takes each file's added and context lines on the new side, not removed ones", () => {
    const diff = [
      'diff --git a/src/a.ts b/src/a.ts',
      'index 1111111..2222222 100644',
      '--- a/src/a.ts',
      '+++ b/src/a.ts',
      '@@ -10,4 +10,4 @@ export function a() {',
      ' keep',
      '-old',
      '+new',
      '',
      ' last',
      '@@ -40 +40,2 @@',
      ' tail',
      '+++ an added line that looks like a header',
      '\\ No newline at end of file',
      'diff --git a/gone.ts b/gone.ts',
      'deleted file mode 100644',
      '--- a/gone.ts',
      '+++ /dev/null',
      '@@ -1,2 +0,0 @@',
      '-one',
      '-two',
      'diff --git a/new.txt b/new.txt',
      'new file mode 100644',
      '--- /dev/null',
      '+++ b/new.txt',
      '@@ -0,0 +1,2 @@',
      '+one',
      '+two',
    ].join('\n')
    const lines = commentableLines(diff)
    expect([...lines.keys()]).toEqual(['src/a.ts', 'new.txt'])
    expect([...(lines.get('src/a.ts') ?? [])]).toEqual([10, 11, 12, 13, 40, 41])
    expect([...(lines.get('new.txt') ?? [])]).toEqual([1, 2])
    expect([...(commentableLines(fixture('pr-1.diff')).get('src/limit.ts') ?? [])]).toEqual([1, 2])
    expect(commentableLines('').size).toBe(0)
  })

  it('takes a path holding a space without the tab git ends it with', () => {
    const diff = ['--- a/my file.ts\t', '+++ b/my file.ts\t', '@@ -1 +1,2 @@', ' one', '+two']
    expect([...(commentableLines(diff.join('\n')).get('my file.ts') ?? [])]).toEqual([1, 2])
  })
})

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
  const diff = [
    'diff --git a/a.ts b/a.ts',
    '--- a/a.ts',
    '+++ b/a.ts',
    '@@ -1 +1,2 @@',
    ' one',
    '+two',
    '',
  ].join('\n')

  /** A clone with the PR's prefetched diff, and the review step's `out/` holding `review`. */
  async function setUp(review?: string) {
    const dir = await mkdtemp(join(tmpdir(), 'awaywork-review-'))
    const context = join(dir, '.away', 'context', 'acme-api-1')
    await mkdir(context, { recursive: true })
    await writeFile(join(context, 'diff.patch'), diff)
    const out = join(dir, 'step-out')
    await mkdir(out)
    if (review !== undefined) await writeFile(join(out, 'review.json'), review)
    const item = githubPr(1, { mine: false })
    const unit = { repo: 'acme/api', base: 'feature-1', items: [item] } as Unit
    return { dir, out, unit }
  }

  it('posts in-diff comments as line comments and folds the rest into the body', async () => {
    const comments = [
      { path: 'a.ts', line: 2, body: 'Why two?' },
      { path: 'a.ts', line: 9, body: 'Far from the diff.' },
      { path: 'b.ts', line: 1, body: 'Not in the PR.' },
    ]
    const { dir, out, unit } = await setUp(JSON.stringify(comments))
    const forge = fakeForge()
    const outcome = await leaveReview(forge, unit, dir, 'abc1234', 'All of it', {
      text: 'Looks fine.',
      out,
    })
    expect(outcome).toEqual({
      kind: 'review',
      url: 'https://example.com/acme/api/pull/1#pullrequestreview-1',
      text: 'All of it',
    })
    expect(forge.reviews).toEqual([
      {
        repo: 'acme/api',
        pr: 1,
        head: 'abc1234',
        body: [
          'Looks fine.',
          '',
          '## Outside the diff',
          '',
          '`a.ts:9`: Far from the diff.',
          '',
          '`b.ts:1`: Not in the PR.',
        ].join('\n'),
        comments: [comments[0]],
      },
    ])
  })

  it('folds every comment into the body when the PR is only linked, so no diff was fetched', async () => {
    const comment = { path: 'a.ts', line: 2, body: 'Why two?' }
    const { dir, out, unit } = await setUp(JSON.stringify([comment]))
    const task = {
      ...githubPr(1),
      key: 'ENG-1',
      type: 'task' as const,
      url: 'https://linear.app/1',
    }
    const forge = fakeForge()
    await leaveReview(forge, { ...unit, items: [task] }, dir, 'abc', 'x', { text: 'Fine.', out })
    expect(forge.reviews.map((r) => [r.body, r.comments])).toEqual([
      ['Fine.\n\n## Outside the diff\n\n`a.ts:2`: Why two?', []],
    ])
  })

  it('posts the body alone with a note when review.json is invalid, and nothing extra when there is none', async () => {
    const invalid = await setUp('{"path": "a.ts"}')
    const forge = fakeForge()
    const last = { text: 'Looks fine.', out: invalid.out }
    expect(await leaveReview(forge, invalid.unit, invalid.dir, 'abc', 'x', last)).toMatchObject({
      kind: 'review',
      note: 'review.json left out: Invalid input: expected array, received object',
    })
    const none = await setUp()
    const plain = await leaveReview(forge, none.unit, none.dir, 'abc', 'x', {
      ...last,
      out: none.out,
    })
    expect(plain).not.toHaveProperty('note')
    expect(forge.reviews.map((r) => [r.body, r.comments])).toEqual([
      ['Looks fine.', []],
      ['Looks fine.', []],
    ])
  })

  it('folds every comment into the body when the forge refuses its line comments', async () => {
    const comments = [
      { path: 'a.ts', line: 2, body: 'Why two?' },
      { path: 'a.ts', line: 9, body: 'Far from the diff.' },
    ]
    const { dir, out, unit } = await setUp(JSON.stringify(comments))
    const forge = fakeForge()
    const post = forge.pendingReview
    forge.pendingReview = async (repo, pr, head, review) => {
      if (review.comments.length)
        throw new Error('Unprocessable Entity: Line could not be resolved')
      return post(repo, pr, head, review)
    }
    const outcome = await leaveReview(forge, unit, dir, 'abc', 'x', { text: 'Fine.', out })
    expect(outcome).toMatchObject({ kind: 'review' })
    expect(forge.reviews.map((r) => [r.body, r.comments])).toEqual([
      ['Fine.\n\n## Outside the diff\n\n`a.ts:2`: Why two?\n\n`a.ts:9`: Far from the diff.', []],
    ])
    forge.pendingReview = async () => {
      throw new Error('Unprocessable Entity')
    }
    const refused = await leaveReview(forge, unit, dir, 'abc', 'x', { text: 'Fine.', out })
    expect(refused).toEqual({ kind: 'report', text: 'x', unposted: 'Unprocessable Entity' })
    let posts = 0
    forge.pendingReview = async () => {
      posts++
      throw new PendingReviewExists('your pending review is there already')
    }
    const there = await leaveReview(forge, unit, dir, 'abc', 'x', { text: 'Fine.', out })
    expect(there).toMatchObject({ unposted: 'your pending review is there already' })
    expect(posts).toBe(1)
  })

  it('delivers the report alone, saying why, when the forge refuses or the diff is a link', async () => {
    const { dir, out, unit } = await setUp('[]')
    const forge = fakeForge()
    forge.pendingReview = async () => {
      throw new Error(
        'your pending review https://github.com/acme/api/pull/1#pullrequestreview-7 is there already\nmore',
      )
    }
    expect(await leaveReview(forge, unit, dir, 'abc', 'Report', { text: 'r', out })).toEqual({
      kind: 'report',
      text: 'Report',
      unposted:
        'your pending review https://github.com/acme/api/pull/1#pullrequestreview-7 is there already',
    })
    await linkDiff(dir)
    const linked = await leaveReview(fakeForge(), unit, dir, 'abc', 'Report', { text: 'r', out })
    expect(linked).toMatchObject({
      kind: 'report',
      unposted: '.away/context/acme-api-1/diff.patch in the clone is a symlink',
    })
    const elsewhere = { ...unit, base: 'feature-9' }
    expect(
      await leaveReview(fakeForge(), elsewhere, dir, 'abc', 'Report', { text: 'r', out }),
    ).toEqual({
      kind: 'report',
      text: 'Report',
      unposted: 'no pull request to review',
    })
  })
})

/** Swaps the prefetched diff for a link a worker could plant. */
async function linkDiff(dir: string) {
  const file = join(dir, '.away', 'context', 'acme-api-1', 'diff.patch')
  await writeFile(`${file}.real`, '')
  await rm(file)
  await symlink(`${file}.real`, file)
}
