import type { Ranked } from './queue.js'

/** Items that share a key or a linked PR (repo + branch) are one feature, unless `alone` keeps one apart; groups and their items keep rank order. */
export function dedupe(ranked: Ranked[], alone = (_: Ranked) => false): Ranked[][] {
  const known = new Map(ranked.map((e) => [e, alone(e) ? [] : featureIds(e)]))
  const ids = (e: Ranked) => known.get(e) ?? []
  let groups: Ranked[][] = []
  for (const entry of ranked) {
    const own = ids(entry)
    const linked = groups.filter((g) => g.some((e) => ids(e).some((id) => own.includes(id))))
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
