import { readFileSync } from 'node:fs'
import { recordedFetch } from './asana.js'

const linearFixture = (name: string) =>
  readFileSync(new URL(`../fixtures/linear/${name}`, import.meta.url), 'utf8')

type Route = Parameters<typeof recordedFetch>[0][number]

/** Routes on the GraphQL body: the operation name and its variables; `first` routes answer before them. */
export const linearFetch = (first: Route[] = []) =>
  recordedFetch([
    ...first,
    [/query Teams/, linearFixture('teams.json')],
    [/query Issues.*"after":"cursor-1"/, linearFixture('issues-2.json')],
    [/query Issues/, linearFixture('issues-1.json')],
    [/query Comments.*000000000012/, linearFixture('comments-12.json')],
    [/query Comments/, linearFixture('comments-empty.json')],
  ])
