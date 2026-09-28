import type { Source } from '../src/core/types.js'
import { asanaSource } from '../src/sources/asana.js'
import { githubSource } from '../src/sources/github.js'
import { providerContract } from './contracts/provider.contract.js'
import { sourceContract } from './contracts/source.contract.js'
import { asanaRoutes, recordedFetch } from './fakes/asana.js'
import { initial, scriptedAsk } from './fakes/ask.js'
import { githubRoutes, recorded } from './fakes/gh.js'
import { fakeItem } from './fakes/items.js'
import { fakeProvider } from './fakes/provider.js'
import { fakeSource } from './fakes/source.js'

providerContract(fakeProvider(), () => ({
  unit: {
    id: 'u1',
    items: [fakeItem()],
    repo: 'acme/api',
    base: 'main',
    foreign: false,
    branch: 'night/FAKE-1',
    rule: { skill: 'fix-ci', where: {}, provider: [], skills: [], instructions: [] },
    skill: 'fix-ci',
    skills: [],
    providers: ['fake'],
    instructions: [],
    deliver: 'draft_pr',
  },
  dir: '/tmp/unused',
  prompt: 'fix it',
  maxTurns: 3,
  env: process.env,
}))

sourceContract(fakeSource() as Source<unknown>, {})
sourceContract(
  githubSource(
    recorded([[/^gh api user --jq/, 'octo'], [/^gh api user\/orgs/, ''], ...githubRoutes()]),
  ) as Source<unknown>,
  { repos: ['acme/*'] },
  {},
  () => scriptedAsk([[/^GitHub repos/, initial]]),
)
sourceContract(
  asanaSource(recordedFetch(asanaRoutes())) as Source<unknown>,
  { workspace: '100' },
  { ASANA_TOKEN: 'pat' },
  () =>
    scriptedAsk([
      [/^Asana workspace/, '100'],
      [/^Asana projects/, ['300']],
      [/^GitHub repo for tasks/, 'acme/api'],
    ]),
)
