import { expect, it } from 'vitest'
import { byHand, GITHUB_ONLY, NOT_YOURS } from '../src/core/continue.js'

it("goes on with its own GitHub draft only at the head it left, body yours, under the cap, else says why it's yours", () => {
  const left = { continued: 2, head: 'abc1234def' }
  const why = (l: Parameters<typeof byHand>[0], now = {}) => Object.values(byHand(l, now) ?? {})
  expect(why(left, { head: left.head })).toEqual([])
  expect(why({ continued: 0 })).toEqual([])
  for (const refused of [GITHUB_ONLY, NOT_YOURS])
    expect(why({ ...left, refused }, { head: left.head })).toEqual(['waiting_for_review', refused])
  expect(why(left, { head: 'f00' })).toEqual([
    'draft_moved',
    'it moved from abc1234, where awaywork left it',
  ])
  expect(why({ ...left, continued: 3 }, { head: left.head })).toEqual([
    'continue_cap',
    'it continued 3 times',
  ])
})
