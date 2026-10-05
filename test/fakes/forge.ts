import type { Forge, Item, PrRef } from '../../src/core/types.js'

export function fakeForge(prs: PrRef[] = []): Forge & {
  branches: Set<string>
  fastForwards: string[]
  stacked: string[][]
  heads: Record<string, { url: string; body: string }[]>
  tips: Record<string, string>
} {
  const branches = new Set<string>()
  const fastForwards: string[] = []
  const stacked: string[][] = []
  const heads: Record<string, { url: string; body: string }[]> = {}
  const tips: Record<string, string> = {}
  return {
    branches,
    fastForwards,
    stacked,
    heads,
    tips,
    clone: async () => {},
    prsFor: async (item: Item) => prs.filter((pr) => pr.branch.includes(item.key)),
    branchExists: async (repo, name) => branches.has(`${repo}:${name}`),
    prsOn: async (repo, branch) => heads[`${repo}:${branch}`] ?? [],
    tipMessage: async (repo, branch) => tips[`${repo}:${branch}`] ?? '',
    push: async (_dir, branch, { repo }) => {
      if (branches.has(`${repo}:${branch}`)) throw new Error(`${branch} already exists`)
      branches.add(`${repo}:${branch}`)
    },
    fastForward: async (_dir, branch, from, { repo, pr }) => {
      fastForwards.push(`${repo}:${branch} (#${pr}) from ${from}`)
    },
    draftPr: async (repo, head) => `https://example.com/${repo}/pull/${head}`,
    stack: async (_repo, below, pr) => {
      stacked.push([below, pr])
    },
  }
}
