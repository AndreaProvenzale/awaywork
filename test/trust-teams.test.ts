import { describe, expect, it } from 'vitest'
import { parseConfig } from '#config/load'
import { trusts } from '#core/trust'
import type { Ctx } from '#core/types'
import type { Exec } from '#forge/gh'
import { resolveTeams, teamMembers } from '#forge/teams'
import { trustFor } from '#plan/repos'
import { githubSource } from '#sources/github'
import { fixture, githubRoutes, recorded } from './fakes/gh'

const yaml = (trust: string, repos = 'repos: { acme/api: }') =>
  parseConfig(`providers: [claude]\nsources: { github: {} }\n${trust}\n${repos}`)

/** Answers a team's members call with its logins, or 404s on any other team. */
const teams = (known: Record<string, string[]>): Exec & { calls: string[][] } => {
  const calls: string[][] = []
  const run = async (_cmd: string, args: string[]) => {
    calls.push(args)
    const team = /^orgs\/(.+)\/teams\/(.+)\/members/
      .exec(args[1] ?? '')
      ?.slice(1, 3)
      .join('/')
    const logins = team ? known[team] : undefined
    if (!logins) throw new Error('gh: Not Found (HTTP 404)')
    return logins.join('\n')
  }
  return Object.assign(run, { calls })
}

describe('trusting a team', () => {
  it('reads the team members endpoint, paginated, as lowercase logins', async () => {
    const run = teams({ 'acme/platform': ['Alice', 'bob'] })
    expect(await teamMembers(run, 'acme/platform')).toEqual(['alice', 'bob'])
    expect(run.calls[0]).toEqual([
      'api',
      'orgs/acme/teams/platform/members?per_page=100',
      '--paginate',
      '--jq',
      '.[].login',
    ])
    expect(await teamMembers(run, 'acme/gone')).toBeUndefined()
  })

  it('trusts a member of a team at the top level and on a repo key, any case, and not others', async () => {
    const config = await resolveTeams(
      yaml('trust: [acme/platform]', 'repos: { acme/api: { trust: [acme/ops] } }'),
      () => {},
      teams({ 'acme/platform': ['Alice'], 'acme/ops': ['bob'] }),
    )
    const list = trustFor(config, 'acme/api')
    expect(list).toEqual(['alice', 'bob'])
    expect(trusts(list, 'ALICE', false)).toBe(true)
    expect(trusts(list, 'Bob', false)).toBe(true)
    expect(trusts(list, 'carol', true)).toBe(false)
  })

  it('looks each team up once across repos and keys, and keeps the other entries', async () => {
    const run = teams({ 'acme/platform': ['alice'] })
    const config = await resolveTeams(
      yaml(
        'trust: [collaborators, acme/platform]',
        'repos: { acme/api: { trust: [acme/platform, dave] }, acme/web: { trust: [acme/platform] } }',
      ),
      () => {},
      run,
    )
    expect(run.calls).toHaveLength(1)
    expect(trustFor(config, 'acme/api')).toEqual(['collaborators', 'alice', 'dave'])
    expect(trustFor(config, 'acme/web')).toEqual(['collaborators', 'alice'])
    expect(
      (config.sources.github as { trust: Record<string, string[]> }).trust['acme/api'],
    ).toEqual(['collaborators', 'alice', 'alice', 'dave'])
  })

  it('trusts nobody from a team it cannot read and logs one line, however often it is named', async () => {
    const log: string[] = []
    const config = await resolveTeams(
      yaml(
        'trust: [acme/gone, alice]',
        'repos: { acme/api: { trust: [acme/gone] }, acme/web: { trust: [acme/gone] } }',
      ),
      (line) => log.push(line),
      teams({}),
    )
    expect(trustFor(config, 'acme/api')).toEqual(['alice'])
    expect(log).toEqual(["github: can't read acme/gone, or it doesn't exist; it trusts nobody"])
  })

  it('leaves a config without teams, and a Bitbucket one, alone and calls nothing', async () => {
    const run = teams({})
    const plain = yaml('trust: [alice]')
    expect(await resolveTeams(plain, () => {}, run)).toBe(plain)
    const bitbucket = parseConfig(
      "providers: [claude]\nforge: bitbucket\nsources: { tracker: { command: 'echo []' } }\ntrust: [acme/platform]\nrepos: { acme/web: }",
    )
    expect(await resolveTeams(bitbucket, () => {}, run)).toBe(bitbucket)
    expect(run.calls).toEqual([])
  })

  it("makes a team member's PR and comments trusted in the github source", async () => {
    const assigned = JSON.parse(fixture('search-assigned.json'))
    const by = (login: string, association: string) => ({
      author: { login, __typename: 'User' },
      authorAssociation: association,
      viewerDidAuthor: false,
      body: login,
      createdAt: '2026-01-01T09:00:00Z',
    })
    assigned.data.search.nodes[0].comments.nodes = [by('Member', 'NONE'), by('outsider', 'NONE')]
    const run = recorded([[/assignee:@me/, JSON.stringify(assigned)], ...githubRoutes()])
    const config = await resolveTeams(
      yaml('trust: [acme/platform]', 'repos: { acme/*: }'),
      () => {},
      teams({ 'acme/platform': ['member'] }),
    )
    const ctx: Ctx = { env: {}, log: () => {} }
    const found = await githubSource(run).items(
      config.sources.github as Parameters<ReturnType<typeof githubSource>['items']>[0],
      ctx,
    )
    expect(found[3]?.comments.map((c) => c.author)).toEqual(['Member'])
  })
})
