import type { Ranked } from './queue.js'

/** Items that share a key or a linked PR (repo + branch) are one feature; groups and their items keep rank order. */
export function dedupe(ranked: Ranked[]): Ranked[][] {
  let groups: Ranked[][] = []
  for (const entry of ranked) {
    const ids = featureIds(entry)
    const linked = groups.filter((g) => g.some((e) => featureIds(e).some((id) => ids.includes(id))))
    groups = [...groups.filter((g) => !linked.includes(g)), [...linked.flat(), entry]]
  }
  const position = (e: Ranked) => ranked.indexOf(e)
  return groups
    .map((g) => g.sort((a, b) => position(a) - position(b)))
    .sort((a, b) => position(a[0] as Ranked) - position(b[0] as Ranked))
}

function featureIds({ item }: Ranked): string[] {
  return [
    `key:${item.source}:${item.key}`,
    ...item.linkedPrs.map((pr) => `pr:${pr.repo}:${pr.branch}`),
  ]
}
