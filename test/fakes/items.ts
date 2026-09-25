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

/** A GitHub PR on acme/api that links itself, as the GitHub source will. */
export function githubPr(n: number, fields: Item['fields'] = {}): Item {
  const branch = `feature-${n}`
  return fakeItem({
    source: 'github',
    id: String(n),
    key: `acme/api#${n}`,
    title: `PR ${n}`,
    url: `https://github.com/acme/api/pull/${n}`,
    linkedPrs: [
      { repo: 'acme/api', number: n, url: `https://github.com/acme/api/pull/${n}`, branch },
    ],
    fields: { repo: 'acme/api', mine: true, checks: 'passing', unresolved_threads: 0, ...fields },
  })
}

export function asanaTask(
  n: number,
  fields: Item['fields'] = {},
  overrides: Partial<Item> = {},
): Item {
  return fakeItem({
    source: 'asana',
    id: String(n),
    key: `T-${n}`,
    type: 'task',
    title: `Task ${n}`,
    url: `https://app.asana.com/0/1/${n}`,
    fields: { project: 'Backend', section: 'Ready', tags: [], ...fields },
    ...overrides,
  })
}
