import { mkdtemp, readdir, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Item } from '../src/core/types.js'
import { sourceField } from '../src/sources/index.js'
import { jira } from '../src/sources/jira.js'
import { scriptedAsk } from './fakes/ask.js'

const {
  JIRA_API_TOKEN,
  JIRA_SITE = '',
  JIRA_EMAIL = '',
  JIRA_CLOUD_ID,
  AWAYWORK_JIRA_PROJECT: project = '',
} = process.env
const ctx = { env: process.env, log: console.log }
const repo = 'awaywork/e2e'
const cfg = {
  site: JIRA_SITE,
  email: JIRA_EMAIL,
  ...(JIRA_CLOUD_ID && { cloud_id: JIRA_CLOUD_ID }),
  jql: `project = ${project}`,
  repo_map: { [project]: repo },
  token_env: 'JIRA_API_TOKEN',
}

/** A REST v3 call on the source's base URL and auth (`call` in jira.ts), for seeding and cleanup. */
async function api<T>(method: string, path: string, body?: object): Promise<T> {
  const base = JIRA_CLOUD_ID
    ? `https://api.atlassian.com/ex/jira/${JIRA_CLOUD_ID}`
    : `https://${JIRA_SITE}`
  const res = await fetch(`${base}/rest/api/3/${path}`, {
    method,
    headers: {
      Authorization: `Basic ${Buffer.from(`${JIRA_EMAIL}:${JIRA_API_TOKEN}`).toString('base64')}`,
      Accept: 'application/json',
      ...(body && { 'Content-Type': 'application/json' }),
    },
    ...(body && { body: JSON.stringify(body) }),
  })
  const json = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(`Jira ${method} ${path}: ${res.status} ${JSON.stringify(json)}`)
  return json as T
}

/**
 * Seeds two issues assigned to me in a test project, one blocking the other, reads them back for
 * real and deletes them; run with JIRA_API_TOKEN, JIRA_SITE, JIRA_EMAIL and AWAYWORK_JIRA_PROJECT
 * set, plus JIRA_CLOUD_ID for a scoped token. The token's user needs Delete issues in the project.
 */
describe.skipIf(!JIRA_API_TOKEN || !JIRA_SITE || !JIRA_EMAIL || !project)(
  'jira source, live',
  () => {
    const run = Date.now().toString(36)
    const label = 'awaywork-e2e'
    const issuetype = 'Task'
    let me = { accountId: '', displayName: '' }
    let priority: { id: string; name: string } | undefined
    let status = ''
    let blocker = ''
    let blocked = ''

    beforeAll(async () => {
      me = await api('GET', 'myself')
      const { issueTypes } = await api<{ issueTypes: { id: string; name: string }[] }>(
        'GET',
        `issue/createmeta/${project}/issuetypes`,
      )
      const type = issueTypes.find((t) => t.name === issuetype)
      if (!type) throw new Error(`${project} has no ${issuetype} issue type`)
      const { fields: meta } = await api<{
        fields: { fieldId: string; allowedValues?: { id: string; name: string }[] }[]
      }>('GET', `issue/createmeta/${project}/issuetypes/${type.id}?maxResults=200`)
      priority = meta.find((f) => f.fieldId === 'priority')?.allowedValues?.[0]
      const create = async (summary: string, extra: object = {}) => {
        const fields = {
          project: { key: project },
          issuetype: { id: type.id },
          summary,
          assignee: { id: me.accountId },
          ...extra,
        }
        return (await api<{ key: string }>('POST', 'issue', { fields })).key
      }
      blocker = await create(`[e2e ${run}] blocker`, {
        labels: [label],
        ...(priority && { priority: { id: priority.id } }),
      })
      const paragraph = {
        type: 'paragraph',
        content: [{ type: 'text', text: `e2e comment ${run}` }],
      }
      await api('POST', `issue/${blocker}/comment`, {
        body: { type: 'doc', version: 1, content: [paragraph] },
      })
      blocked = await create(`[e2e ${run}] blocked`)
      // The inward issue blocks the outward one, as the blocked issue's links then report it.
      await api('POST', 'issueLink', {
        type: { name: 'Blocks' },
        inwardIssue: { key: blocker },
        outwardIssue: { key: blocked },
      })
      status = (
        await api<{ fields: { status: { name: string } } }>('GET', `issue/${blocker}?fields=status`)
      ).fields.status.name
    }, 60_000)

    /** Deletes each seeded issue, with its comment and link, then fails naming what is left behind. */
    afterAll(async () => {
      const left: Error[] = []
      for (const key of [blocked, blocker].filter(Boolean))
        await api('DELETE', `issue/${key}`).catch((cause) =>
          left.push(new Error(`issue ${key} left in ${project}`, { cause })),
        )
      if (left.length) throw new AggregateError(left, 'cleanup left seeded items behind')
    }, 60_000)

    /** Search is eventually consistent, so read until both issues and their link show up. */
    async function seeded(): Promise<{ blocker: Item; blocked: Item }> {
      for (let deadline = Date.now() + 90_000; ; await new Promise((r) => setTimeout(r, 5_000))) {
        const items = await jira.items(cfg, ctx)
        const found = {
          blocker: items.find((i) => i.key === blocker),
          blocked: items.find((i) => i.key === blocked),
        }
        // Either end blocked means the link is indexed; which end is the assertion's job.
        if (
          found.blocker &&
          found.blocked &&
          (found.blocker.fields.blocked || found.blocked.fields.blocked)
        )
          return found as { blocker: Item; blocked: Item }
        if (Date.now() > deadline)
          throw new Error(
            `seeded issues never showed up: ${JSON.stringify([found.blocker?.fields, found.blocked?.fields])}`,
          )
      }
    }

    it('reads the seeded issues with their fields and comment', async () => {
      const found = await seeded()
      for (const item of Object.values(found))
        for (const [key, value] of Object.entries(item.fields))
          for (const v of [value].flat())
            expect(sourceField(jira.fields, key)?.safeParse(v).success).toBe(true)

      const fields = { project, status, issuetype, repo }
      expect(found.blocker).toMatchObject({
        title: `[e2e ${run}] blocker`,
        assignee: me.displayName,
        labels: [label],
        fields: {
          ...fields,
          labels: [label],
          ...(priority && { priority: priority.name }),
          blocked: false,
        },
      })
      expect(found.blocker.comments.map((c) => c.body)).toEqual([`e2e comment ${run}`])
      expect(found.blocked).toMatchObject({
        title: `[e2e ${run}] blocked`,
        assignee: me.displayName,
        fields: { ...fields, labels: [], blocked: true },
      })

      const dir = await mkdtemp(join(tmpdir(), 'awaywork-real-'))
      await jira.prefetch(found.blocker, dir, ctx)
      expect(await readdir(dir)).toEqual(['item.md'])
      expect(await readFile(join(dir, 'item.md'), 'utf8')).toContain(`e2e comment ${run}`)
    }, 120_000)

    it('offers the real project and status names at init', async () => {
      const ask = scriptedAsk([
        [/^Jira Cloud site/, JIRA_SITE],
        [/^Atlassian account email/, JIRA_EMAIL],
        [/^Is the token scoped/, Boolean(JIRA_CLOUD_ID)],
        [/^Jira projects/, [project]],
        [new RegExp(`^GitHub repo for issues in ${project} `), repo],
      ])
      const setup = await jira.init?.(ask, ctx)
      expect(setup?.config).toEqual({
        site: JIRA_SITE,
        email: JIRA_EMAIL,
        ...(JIRA_CLOUD_ID && { cloud_id: JIRA_CLOUD_ID }),
        repo_map: { [project]: repo },
      })
      expect(setup?.values?.project).toContain(project)
      expect(setup?.values?.status).toContain(status)
    }, 30_000)
  },
)
