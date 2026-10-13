import { readFileSync } from 'node:fs'
import { recordedFetch } from './asana.js'

const linearFixture = (name: string) =>
  readFileSync(new URL(`../fixtures/linear/${name}`, import.meta.url), 'utf8')

/** Routes on the GraphQL body: the operation name and its variables. */
export const linearFetch = () =>
  recordedFetch([
    [/query Teams/, linearFixture('teams.json')],
    [/query Issues.*"after":"cursor-1"/, linearFixture('issues-2.json')],
    [/query Issues/, linearFixture('issues-1.json')],
    [/query Comments.*000000000012/, linearFixture('comments-12.json')],
    [/query Comments/, linearFixture('comments-empty.json')],
  ])
