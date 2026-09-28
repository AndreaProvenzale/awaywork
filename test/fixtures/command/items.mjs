const items = [
  {
    id: '42',
    key: 'AI-42',
    title: 'Export invoices as CSV',
    url: 'https://tracker.example/cards/AI-42',
    description: 'Users want a CSV export.',
    comments: [{ author: 'qa', body: 'The header row is missing.', at: '2026-01-02T10:00:00Z' }],
    fields: { column: 'QA', repo: 'acme/api', updated: '2026-01-02T10:00:00+01:00' },
    context: process.env.TRACKER_CONTEXT,
  },
]
console.log(JSON.stringify(items))
