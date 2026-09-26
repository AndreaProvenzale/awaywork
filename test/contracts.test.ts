import type { Source } from '../src/core/types.js'
import { asanaSource } from '../src/sources/asana.js'
import { githubSource } from '../src/sources/github.js'
import { providerContract } from './contracts/provider.contract.js'
import { sourceContract } from './contracts/source.contract.js'
import { asanaRoutes, recordedFetch } from './fakes/asana.js'
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
}))

sourceContract(fakeSource() as Source<unknown>, {})
sourceContract(githubSource(recorded(githubRoutes())) as Source<unknown>, { repos: ['acme/*'] })
sourceContract(
  asanaSource(recordedFetch(asanaRoutes())) as Source<unknown>,
  { workspace: '100' },
  { ASANA_TOKEN: 'pat' },
)
