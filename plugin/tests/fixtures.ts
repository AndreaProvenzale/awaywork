// Made-up repos and keys, shaped as `awaywork report --json` and `plan --json` print them.

const item = (n: number, title: string) => ({
  source: 'github',
  key: `acme/shop#${n}`,
  title,
  url: `https://github.com/acme/shop/issues/${n}`,
})

const unit = (n: number, skill: string, title: string) => ({
  id: `acme-shop-${n}`,
  repo: 'acme/shop',
  skill,
  deliver: 'draft_pr',
  items: [item(n, title)],
})

const skipped = [
  {
    item: item(7, 'Retry webhooks on 5xx'),
    kind: 'waiting_for_review',
    reason: 'waiting for your review of awaywork PR #31',
    url: 'https://github.com/acme/shop/pull/31',
    needsYou: true,
  },
  {
    item: item(8, 'Split the checkout service'),
    kind: 'waiting_for_approval',
    reason: 'waiting for your approval of the plan awaywork posted',
    url: 'https://github.com/acme/shop/issues/8',
    needsYou: true,
  },
  { item: item(9, 'Bump the linter'), kind: 'no_rule', reason: 'no rule takes it' },
  { item: item(10, 'Rewrite in Rust'), kind: 'skipped_by_you', reason: 'skipped by you' },
]

const queue = [
  { skill: 'fix', where: { type: 'pr', checks: 'failing' } },
  { skill: 'implement', where: { type: 'issue', approved: true } },
]

export const busyReport = {
  runId: '20990101-050000',
  dryRun: false,
  startedAt: '2099-01-01T05:00:00.000Z',
  finishedAt: '2099-01-01T06:10:00.000Z',
  plan: { queue, units: [], skipped },
  results: [
    {
      planned: { unit: unit(3, 'fix', 'Flaky cart test') },
      status: 'done',
      summary: 'Pinned the clock in the cart test',
      outcome: { kind: 'pr', url: 'https://github.com/acme/shop/pull/40', commits: 1 },
    },
    {
      planned: {
        unit: { ...unit(3, 'review', 'Flaky cart test'), id: 'acme-shop-3-2' },
        chain: 'acme-shop-3',
      },
      status: 'done',
    },
    {
      planned: { unit: unit(5, 'implement', 'Dark mode toggle') },
      status: 'failed',
      reason: 'verify failed: pnpm test',
    },
  ],
  quotas: {},
}

export const busyPlan = {
  queue,
  units: [
    { unit: unit(12, 'implement', 'Coupon codes'), provider: 'claude' },
    {
      unit: { ...unit(12, 'review', 'Coupon codes'), id: 'acme-shop-12-2' },
      chain: 'acme-shop-12',
    },
  ],
  skipped,
  warnings: [],
}

export const emptyReport = { ...busyReport, plan: { queue, units: [], skipped: [] }, results: [] }

export const emptyPlan = { queue, units: [], skipped: [], warnings: [] }
