import { describe, expect, it } from 'vitest'
import { dedupe } from '../src/core/dedupe.js'
import type { Ranked } from '../src/core/queue.js'
import type { Item } from '../src/core/types.js'
import { asanaTask, githubPr } from './fakes/items.js'

const keys = (groups: Ranked[][]) => groups.map((g) => g.map((e) => `${e.item.key}@${e.rule}`))
const linkedTo = (pr: Item) => ({ linkedPrs: pr.linkedPrs })

describe('dedupe', () => {
  it('keeps unrelated items apart', () => {
    expect(
      keys(
        dedupe([
          { item: githubPr(1), rule: 0 },
          { item: githubPr(2), rule: 1 },
        ]),
      ),
    ).toEqual([['acme/api#1@0'], ['acme/api#2@1']])
  })

  it('merges a task into the PR it links, under the higher-ranked rule', () => {
    const pr = githubPr(1)
    const task = asanaTask(7, {}, linkedTo(pr))
    expect(
      keys(
        dedupe([
          { item: task, rule: 1 },
          { item: pr, rule: 3 },
        ]),
      ),
    ).toEqual([['T-7@1', 'acme/api#1@3']])
  })

  it('merges transitively and keeps group order by best rank', () => {
    const [pr1, pr2] = [githubPr(1), githubPr(2)]
    const bridge = asanaTask(9, {}, { linkedPrs: [...pr1.linkedPrs, ...pr2.linkedPrs] })
    const ranked = [
      { item: githubPr(5), rule: 0 },
      { item: pr1, rule: 1 },
      { item: pr2, rule: 2 },
      { item: bridge, rule: 4 },
    ]
    expect(keys(dedupe(ranked))).toEqual([
      ['acme/api#5@0'],
      ['acme/api#1@1', 'acme/api#2@2', 'T-9@4'],
    ])
  })

  it('treats the same key from two sources as different items', () => {
    const a = asanaTask(1)
    const b = { ...githubPr(1), key: 'T-1', linkedPrs: [] }
    expect(
      dedupe([
        { item: a, rule: 0 },
        { item: b, rule: 0 },
      ]),
    ).toHaveLength(2)
  })
})
