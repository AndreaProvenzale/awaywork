import type { Source } from '../src/core/types.js'
import { asanaSource } from '../src/sources/asana.js'
import { githubSource } from '../src/sources/github.js'
import { jiraSource } from '../src/sources/jira.js'
import { linearSource } from '../src/sources/linear.js'
import { routines } from '../src/sources/routines.js'
import { providerContract } from './contracts/provider.contract.js'
import { sourceContract } from './contracts/source.contract.js'
import { asanaRoutes, recordedFetch } from './fakes/asana.js'
import { initial, scriptedAsk } from './fakes/ask.js'
import { githubRoutes, recorded } from './fakes/gh.js'
import { fakeItem } from './fakes/items.js'
import { jiraFetch } from './fakes/jira.js'
import { linearFetch } from './fakes/linear.js'
import { fakeProvider } from './fakes/provider.js'
import { fakeSource } from './fakes/source.js'

providerContract(fakeProvider(), () => ({
  unit: {
    id: 'u1',
    items: [fakeItem()],
    repo: 'acme/api',
    base: 'main',
    foreign: false,
    untrusted: false,
    branch: 'away/FAKE-1',
    rule: { skill: 'fix', where: {}, provider: [], skills: [], instructions: [] },
    skill: 'fix',
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
sourceContract(routines as Source<unknown>, {
  'sentry-triage': { days: ['mon'], at: '09:00', repo: 'acme/api', title: 'Triage Sentry' },
})
sourceContract(
  githubSource(
    recorded([
      [/^gh api user --jq/, 'octo'],
      [/^gh api user\/orgs/, ''],
      [/^gh api repos\/acme\/api\/issues\/1\/labels /, '[]'],
      [
        /issueOrPullRequest/,
        '{ "data": { "viewer": { "login": "dev" }, "repository": { "issueOrPullRequest": { "updatedAt": "2026-02-02T08:00:00Z" } } } }',
      ],
      ...githubRoutes(),
    ]),
  ) as Source<unknown>,
  { repos: ['acme/*'] },
  {},
  () => scriptedAsk([[/^GitHub repos/, initial]]),
  'qa',
)
sourceContract(
  asanaSource(
    recordedFetch([
      [
        /\/projects\/11\/sections\?/,
        '{ "data": [{ "gid": "21", "name": "QA" }], "next_page": null }',
      ],
      [/\/sections\/21\/addTask$/, '{ "data": {} }'],
      [
        /\/tasks\/1201\?opt_fields=modified_at,assignee$/,
        '{ "data": { "modified_at": "2026-01-04T08:00:00.000Z", "assignee": { "gid": "900" } } }',
      ],
      ...asanaRoutes(),
    ]),
  ) as Source<unknown>,
  { workspace: '100' },
  { ASANA_TOKEN: 'pat' },
  () =>
    scriptedAsk([
      [/^Asana workspace/, '100'],
      [/^Asana projects/, ['300']],
      [/^GitHub repo for tasks/, 'acme/api'],
    ]),
  'QA',
)
sourceContract(
  linearSource(
    linearFetch([
      [
        /query States/,
        '{ "data": { "issue": { "updatedAt": "2026-01-03T08:00:00.000Z", "assignee": { "isMe": true }, "team": { "states": { "nodes": [{ "id": "s1", "name": "In Review" }] } } } } }',
      ],
      [/mutation IssueMove/, '{ "data": { "issueUpdate": { "success": true } } }'],
      [
        /query Updated/,
        '{ "data": { "issue": { "updatedAt": "2026-01-04T08:00:00.000Z", "assignee": { "isMe": true } } } }',
      ],
    ]),
  ) as Source<unknown>,
  {},
  { LINEAR_API_KEY: 'lin_api_key' },
  () =>
    scriptedAsk([
      [/^Linear teams/, ['ENG']],
      [/^GitHub repo for issues in ENG/, 'acme/api'],
    ]),
  'In Review',
)
sourceContract(
  jiraSource(
    jiraFetch([
      [
        /\/issue\/10012\?fields=updated,assignee&expand=transitions$/,
        '{ "fields": { "updated": "2026-01-03T08:00:00.000+0000", "assignee": { "accountId": "5b10" } }, "transitions": [{ "id": "21", "to": { "name": "In Review" } }] }',
      ],
      [/\/issue\/10012\/transitions$/, '{}'],
      [
        /\/issue\/10012\?fields=updated$/,
        '{ "fields": { "updated": "2026-01-04T08:00:00.000+0000" } }',
      ],
    ]),
  ) as Source<unknown>,
  { site: 'acme.atlassian.net', email: 'dev@acme.test' },
  { JIRA_API_TOKEN: 'atl-token' },
  () =>
    scriptedAsk([
      [/^Jira Cloud site/, 'https://acme.atlassian.net/'],
      [/^Atlassian account email/, 'dev@acme.test'],
      [/^Is the token scoped/, true],
      [/^Jira projects/, ['ENG']],
      [/^GitHub repo for issues in ENG/, 'acme/api'],
    ]),
  'In Review',
)
