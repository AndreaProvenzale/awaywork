import type { Item } from '../../src/core/types.js'

export function fakeItem(overrides: Partial<Item> = {}): Item {
  return {
    source: 'fake',
    id: '1',
    key: 'FAKE-1',
    type: 'pr',
    title: 'Fix the thing',
    description: '',
    url: 'https://example.com/1',
    status: 'open',
    reviewers: [],
    labels: [],
    comments: [],
    linkedPrs: [],
    fields: { mine: true, checks: 'failing' },
    raw: null,
    ...overrides,
  }
}
