import type { Forge, Item, PrRef } from '../../src/core/types.js'

export function fakeForge(
  prs: PrRef[] = [],
): Forge & { branches: Set<string>; fastForwards: string[] } {
  const branches = new Set<string>()
  const fastForwards: string[] = []
  return {
    branches,
    fastForwards,
    clone: async () => {},
    prsFor: async (item: Item) => prs.filter((pr) => pr.branch.includes(item.key)),
    branchExists: async (repo, name) => branches.has(`${repo}:${name}`),
    push: async (_dir, branch, { repo }) => {
      if (branches.has(`${repo}:${branch}`)) throw new Error(`${branch} already exists`)
      branches.add(`${repo}:${branch}`)
    },
    fastForward: async (_dir, branch, from, { repo }) => {
      fastForwards.push(`${repo}:${branch} from ${from}`)
    },
    draftPr: async (repo, head) => `https://example.com/${repo}/pull/${head}`,
  }
}
