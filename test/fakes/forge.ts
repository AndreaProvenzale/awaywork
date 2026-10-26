import type { BranchPr, Forge, Item, PrRef, Review } from '../../src/core/types.js'

export function fakeForge(prs: PrRef[] = []): Forge & {
  branches: Set<string>
  fastForwards: string[]
  stacked: string[][]
  reviews: ({ repo: string; pr: number; head: string } & Review)[]
  heads: Record<string, ({ url: string; body: string } & Partial<BranchPr>)[]>
  tips: Record<string, string>
  files: Record<string, string>
} {
  const branches = new Set<string>()
  const fastForwards: string[] = []
  const stacked: string[][] = []
  const reviews: ({ repo: string; pr: number; head: string } & Review)[] = []
  const heads: Record<string, ({ url: string; body: string } & Partial<BranchPr>)[]> = {}
  const tips: Record<string, string> = {}
  const files: Record<string, string> = {}
  return {
    branches,
    fastForwards,
    stacked,
    reviews,
    heads,
    tips,
    files,
    clone: async () => {},
    prsFor: async (item: Item) => prs.filter((pr) => pr.branch.includes(item.key)),
    branchExists: async (repo, name) => branches.has(`${repo}:${name}`),
    prsOn: async (repo, branch) =>
      (heads[`${repo}:${branch}`] ?? []).map((pr) => ({
        number: Number(pr.url.split('/').at(-1)) || 0,
        open: !pr.merged,
        merged: false,
        ...pr,
      })),
    tipMessage: async (repo, branch) => tips[`${repo}:${branch}`] ?? '',
    fileAt: async (repo, ref, path) => files[`${repo}@${ref}:${path}`],
    push: async (_dir, branch, { repo }) => {
      if (branches.has(`${repo}:${branch}`)) throw new Error(`${branch} already exists`)
      branches.add(`${repo}:${branch}`)
    },
    fastForward: async (_dir, branch, from, { repo, pr }) => {
      fastForwards.push(`${repo}:${branch} (#${pr}) from ${from}`)
    },
    openPr: async (repo, head) => `https://example.com/${repo}/pull/${head}`,
    stack: async (_repo, below, pr) => {
      stacked.push([below, pr])
    },
    pendingReview: async (repo, pr, head, review) => {
      reviews.push({ repo, pr, head, ...review })
      return `https://example.com/${repo}/pull/${pr}#pullrequestreview-1`
    },
  }
}
