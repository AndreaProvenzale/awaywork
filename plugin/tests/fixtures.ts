// Made-up repos and keys, shaped as `awaywork report --json` and `plan --json` print them.

const item = (repo: string, n: number, title: string) => ({
  source: 'github',
  key: `${repo}#${n}`,
  title,
  url: `https://github.com/${repo}/issues/${n}`,
})

const ticket = (n: number, title: string) => ({
  source: 'jira',
  key: `SHOP-${n}`,
  title,
  url: `https://acme.atlassian.net/browse/SHOP-${n}`,
})

const unit = (repo: string, n: number, skill: string, title: string) => ({
  id: `${repo.replace('/', '-')}-${n}`,
  repo,
  skill,
  deliver: 'draft_pr',
  items: [item(repo, n, title)],
})

const needsYou = (i: ReturnType<typeof item>, kind: string, reason: string, url = i.url) => ({
  item: i,
  kind,
  reason,
  url,
  needsYou: true,
})

const answer = ticket(12, 'Migrate the billing webhooks to the new event bus before the freeze')

// Listed as the plan lists them: the pane groups them by repo and orders them by action.
const skipped = [
  needsYou(
    item('acme/shop', 8, 'Split the checkout service into cart, payment and shipping'),
    'waiting_for_approval',
    'waiting for your approval of the plan on https://github.com/acme/shop/issues/8',
  ),
  needsYou(answer, 'waiting_for_answer', `waiting for your answer on ${answer.url}`),
  needsYou(
    item('acme/shop', 7, 'Retry webhooks on 5xx'),
    'waiting_for_review',
    'waiting for review: awaywork PR https://github.com/acme/shop/pull/31 is open',
    'https://github.com/acme/shop/pull/31',
  ),
  needsYou(
    item('acme/api', 21, 'Fix the N+1 query in the orders endpoint'),
    'waiting_for_review',
    'waiting for review: awaywork PR https://github.com/acme/api/pull/44 is open',
    'https://github.com/acme/api/pull/44',
  ),
  needsYou(
    item('acme/api', 22, 'Add OpenTelemetry traces to the worker'),
    'gave_up',
    'gave up after 3 failed runs; retries on 2099-01-03',
  ),
  needsYou(
    item('acme/web', 4, 'Dark mode toggle'),
    'waiting_for_answer',
    'waiting for your answer on https://github.com/acme/web/issues/4',
  ),
  {
    item: item('acme/shop', 10, 'Rewrite in Rust'),
    kind: 'skipped_by_you',
    reason: 'skipped with awaywork skip github:acme/shop#10: not now',
  },
  {
    item: item('acme/shop', 9, 'Bump the linter'),
    kind: 'no_rule',
    reason: 'matched no rule; closest #1 fix: type is issue, wants pr',
  },
  {
    item: item('acme/api', 30, 'Rename the billing tables'),
    kind: 'over_cap',
    reason: 'over the cap: 3 units per run for implement',
  },
  {
    item: item('acme/web', 5, 'Drop Node 18'),
    kind: 'unchanged',
    reason: 'unchanged since the last run',
  },
  {
    item: ticket(14, 'Cache product images at the edge'),
    kind: 'no_rule',
    reason: 'matched no rule; closest #2 implement: label is awaywork',
  },
]

const queue = [
  { skill: 'fix', where: { type: 'pr', checks: 'failing' } },
  { skill: 'implement', where: { type: 'issue' } },
]

export const busyReport = {
  runId: '20990101-050000',
  dryRun: false,
  startedAt: '2099-01-01T05:00:00.000Z',
  finishedAt: '2099-01-01T06:10:00.000Z',
  plan: { queue, units: [], skipped },
  results: [
    {
      planned: { unit: unit('acme/shop', 3, 'fix', 'Flaky cart test') },
      status: 'done',
      summary: 'Pinned the clock in the cart test',
      outcome: { kind: 'pr', url: 'https://github.com/acme/shop/pull/40', commits: 1 },
    },
    {
      planned: {
        unit: { ...unit('acme/shop', 3, 'review', 'Flaky cart test'), id: 'acme-shop-3-2' },
        chain: 'acme-shop-3',
      },
      status: 'done',
    },
    {
      planned: { unit: unit('acme/shop', 5, 'implement', 'Dark mode toggle') },
      status: 'failed',
      reason: 'verify failed: pnpm test',
    },
  ],
  quotas: {},
}

export const busyPlan = {
  queue,
  units: [
    { unit: unit('acme/shop', 12, 'implement', 'Coupon codes'), provider: 'claude' },
    {
      unit: { ...unit('acme/shop', 12, 'review', 'Coupon codes'), id: 'acme-shop-12-2' },
      chain: 'acme-shop-12',
    },
  ],
  skipped,
  warnings: [],
}

export const emptyReport = { ...busyReport, plan: { queue, units: [], skipped: [] }, results: [] }

export const emptyPlan = { queue, units: [], skipped: [], warnings: [] }
