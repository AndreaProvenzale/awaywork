import { mkdtemp, readdir, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Item } from '../src/core/types.js'
import { sourceField } from '../src/sources/index.js'
import { API, linear } from '../src/sources/linear.js'
import { scriptedAsk } from './fakes/ask.js'

const token = process.env.LINEAR_API_KEY ?? ''
const team = process.env.NIGHTSHIFT_LINEAR_TEAM ?? ''
const repo = 'night-shift/e2e'
const ctx = { env: process.env, log: console.log }

/** Runs one GraphQL operation with the test's key, failing on any error. */
async function gql<T>(query: string, variables: object = {}): Promise<T> {
  const res = await fetch(API, {
    method: 'POST',
    headers: { Authorization: token, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, variables }),
  })
  const body = await res.json().catch(() => ({}))
  if (!res.ok || body.errors?.length)
    throw new Error(`Linear API: ${res.status} ${JSON.stringify(body.errors ?? body)}`)
  return body.data as T
}

/** Deletes one issue or label by id; a deleted issue goes to the trash for 30 days. */
async function remove(mutation: 'issueDelete' | 'issueLabelDelete', id: string) {
  const data = await gql<Record<string, { success: boolean }>>(
    `mutation Remove($id: String!) { ${mutation}(id: $id) { success } }`,
    { id },
  )
  if (!data[mutation]?.success) throw new Error(`${mutation} did not succeed`)
}

interface Seeded {
  id: string
  identifier: string
}

/**
 * Seeds a labelled, prioritized issue with a comment and an issue it blocks in a test team,
 * reads them back for real and deletes them; run with LINEAR_API_KEY (read and write) and
 * NIGHTSHIFT_LINEAR_TEAM set to the key of a team the key's user is a member of.
 */
describe.skipIf(!token || !team)('linear source, live', () => {
  const run = Date.now().toString(36)
  const label = `night-shift-e2e-${run}`
  const comment = `e2e comment ${run}`
  let viewer = ''
  let state = ''
  let labelId = ''
  let blocker: Seeded | undefined
  let blocked: Seeded | undefined

  beforeAll(async () => {
    const found = await gql<{
      viewer: { id: string; name: string }
      teams: {
        nodes: { id: string; states: { nodes: { id: string; name: string; type: string }[] } }[]
      }
    }>(
      `query Seed($key: String!) {
        viewer { id name }
        teams(filter: { key: { eq: $key } }) { nodes { id states { nodes { id name type } } } }
      }`,
      { key: team },
    )
    viewer = found.viewer.name
    const [teamNode] = found.teams.nodes
    if (!teamNode) throw new Error(`no Linear team with key ${team}`)
    const started = teamNode.states.nodes.find((s) => s.type === 'started')
    if (!started) throw new Error(`team ${team} has no started state`)
    state = started.name

    const created = await gql<{ issueLabelCreate: { issueLabel: { id: string } } }>(
      `mutation Label($input: IssueLabelCreateInput!) {
        issueLabelCreate(input: $input) { issueLabel { id } }
      }`,
      { input: { name: label, teamId: teamNode.id } },
    )
    labelId = created.issueLabelCreate.issueLabel.id
    const issue = async (input: object) => {
      const data = await gql<{ issueCreate: { issue: Seeded } }>(
        `mutation Issue($input: IssueCreateInput!) {
          issueCreate(input: $input) { issue { id identifier } }
        }`,
        {
          input: {
            teamId: teamNode.id,
            assigneeId: found.viewer.id,
            stateId: started.id,
            ...input,
          },
        },
      )
      return data.issueCreate.issue
    }
    blocker = await issue({
      title: `[e2e ${run}] blocker`,
      description: 'Seeded.',
      labelIds: [labelId],
      priority: 2,
    })
    blocked = await issue({ title: `[e2e ${run}] blocked` })
    await gql(
      `mutation Comment($input: CommentCreateInput!) { commentCreate(input: $input) { success } }`,
      { input: { issueId: blocker.id, body: comment } },
    )
    await gql(
      `mutation Relation($input: IssueRelationCreateInput!) {
        issueRelationCreate(input: $input) { success }
      }`,
      { input: { issueId: blocker.id, relatedIssueId: blocked.id, type: 'blocks' } },
    )
  }, 60_000)

  /** Deletes each seeded thing that was created, then fails naming whatever is left behind. */
  afterAll(async () => {
    const left: Error[] = []
    const undo = (what: string, step: Promise<unknown>) =>
      step.catch((cause) => left.push(new Error(`${what} left in team ${team}`, { cause })))
    for (const issue of [blocked, blocker])
      if (issue) await undo(`issue ${issue.identifier}`, remove('issueDelete', issue.id))
    if (labelId) await undo(`label ${label}`, remove('issueLabelDelete', labelId))
    if (left.length) throw new AggregateError(left, 'cleanup left seeded items behind')
  }, 60_000)

  it('reads the seeded issues with their fields and comments', async () => {
    const items = await linear.items(
      { team_repos: { [team]: repo }, token_env: 'LINEAR_API_KEY' },
      ctx,
    )
    for (const item of items)
      for (const [key, value] of Object.entries(item.fields))
        for (const v of [value].flat())
          expect(sourceField(linear.fields, key)?.safeParse(v).success).toBe(true)

    // The source reads everything assigned to the key's user, so only the seeded keys are checked.
    const byKey = (key = ''): Item => {
      const item = items.find((i) => i.key === key)
      if (!item) throw new Error(`seeded issue ${key} not read`)
      return item
    }
    const first = byKey(blocker?.identifier)
    const second = byKey(blocked?.identifier)
    const dates = { created: expect.any(String), updated: expect.any(String) }
    expect(first).toMatchObject({ type: 'task', assignee: viewer, labels: [label] })
    expect(first.fields).toEqual({
      team,
      state,
      labels: [label],
      priority: 'High',
      blocked: false,
      repo,
      ...dates,
    })
    expect(first.comments.map((c) => c.body)).toEqual([comment])
    expect(second.fields).toEqual({
      team,
      state,
      labels: [],
      priority: 'No priority',
      blocked: true,
      repo,
      ...dates,
    })

    const dir = await mkdtemp(join(tmpdir(), 'nightshift-real-'))
    await linear.prefetch(first, dir, ctx)
    expect(await readdir(dir)).toEqual(['issue.md'])
    expect(await readFile(join(dir, 'issue.md'), 'utf8')).toContain(comment)
  }, 120_000)

  it('offers the real team and state names at init', async () => {
    const ask = scriptedAsk([
      [/Linear teams/, [team]],
      [/GitHub repo for issues in/, repo],
    ])
    const setup = await linear.init?.(ask, ctx)
    expect(setup?.config).toEqual({ team_repos: { [team]: repo } })
    expect(setup?.values?.team).toContain(team)
    expect(setup?.values?.state).toContain(state)
  }, 30_000)
})
