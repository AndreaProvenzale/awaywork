import { mkdtemp, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { sourceField } from '../src/sources/index.js'
import { jira } from '../src/sources/jira.js'

const { JIRA_API_TOKEN, JIRA_SITE, JIRA_EMAIL, JIRA_CLOUD_ID } = process.env

/** Reads the real Jira Cloud API; run with JIRA_API_TOKEN, JIRA_SITE and JIRA_EMAIL set, plus JIRA_CLOUD_ID for a scoped token. */
it.skipIf(!JIRA_API_TOKEN || !JIRA_SITE || !JIRA_EMAIL)(
  'reads my real Jira issues and prefetches one',
  async () => {
    const ctx = { env: process.env, log: console.log }
    const cfg = {
      site: JIRA_SITE ?? '',
      email: JIRA_EMAIL ?? '',
      ...(JIRA_CLOUD_ID && { cloud_id: JIRA_CLOUD_ID }),
      token_env: 'JIRA_API_TOKEN',
    }
    const items = await jira.items(cfg, ctx)
    console.log(items.map((i) => `${i.key} ${JSON.stringify(i.fields)}`).join('\n'))
    for (const item of items)
      for (const [key, value] of Object.entries(item.fields))
        for (const v of [value].flat())
          expect(sourceField(jira.fields, key)?.safeParse(v).success).toBe(true)
    const [first] = items
    if (!first) return
    const dir = await mkdtemp(join(tmpdir(), 'nightshift-real-'))
    await jira.prefetch(first, dir, ctx)
    expect(await readdir(dir)).toEqual(['issue.md'])
  },
  120_000,
)
