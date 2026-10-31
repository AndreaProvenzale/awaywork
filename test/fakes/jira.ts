import { readFileSync } from 'node:fs'
import { recordedFetch } from './asana.js'

export const jiraFixture = (name: string) =>
  readFileSync(new URL(`../fixtures/jira/${name}`, import.meta.url), 'utf8')

type Route = Parameters<typeof recordedFetch>[0][number]

/** The recorded site; `first` routes answer before it. */
export const jiraFetch = (first: Route[] = []) =>
  recordedFetch([
    ...first,
    [/\/_edge\/tenant_info$/, jiraFixture('tenant_info.json')],
    [/\/rest\/api\/3\/field$/, jiraFixture('fields.json')],
    [/"nextPageToken":"token-2"/, jiraFixture('search-2.json')],
    [/\/rest\/api\/3\/search\/jql$/, jiraFixture('search-1.json')],
    [/\/issue\/10012\/comment/, jiraFixture('comments-10012.json')],
    [/\/issue\/\d+\/comment/, jiraFixture('comments-empty.json')],
    [/\/rest\/api\/3\/project\/search/, jiraFixture('projects.json')],
    [/\/rest\/api\/3\/status$/, jiraFixture('statuses.json')],
    [/\/rest\/api\/3\/myself$/, '{ "accountId": "5b10", "displayName": "Dev" }'],
  ])
