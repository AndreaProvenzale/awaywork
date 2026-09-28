import { mkdtemp, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { sourceField } from '../src/sources/index.js'
import { linear } from '../src/sources/linear.js'

/** Reads the real Linear API; run with LINEAR_API_KEY set. */
it.skipIf(!process.env.LINEAR_API_KEY)(
  'reads my real Linear issues and prefetches one',
  async () => {
    const ctx = { env: process.env, log: console.log }
    const items = await linear.items({ token_env: 'LINEAR_API_KEY' }, ctx)
    console.log(items.map((i) => `${i.key} ${JSON.stringify(i.fields)}`).join('\n'))
    for (const item of items)
      for (const [key, value] of Object.entries(item.fields))
        for (const v of [value].flat())
          expect(sourceField(linear.fields, key)?.safeParse(v).success).toBe(true)
    const [first] = items
    if (!first) return
    const dir = await mkdtemp(join(tmpdir(), 'nightshift-real-'))
    await linear.prefetch(first, dir, ctx)
    expect(await readdir(dir)).toEqual(['issue.md'])
  },
  120_000,
)
