import { mkdtemp, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { asana } from '../src/sources/asana.js'
import { sourceField } from '../src/sources/index.js'

const workspace = process.env.NIGHTSHIFT_ASANA_WORKSPACE

/** Reads the real Asana API; run with ASANA_TOKEN and NIGHTSHIFT_ASANA_WORKSPACE set. */
it.skipIf(!process.env.ASANA_TOKEN || !workspace)(
  'reads my real Asana tasks and prefetches one',
  async () => {
    const ctx = { env: process.env, log: console.log }
    const items = await asana.items({ workspace: workspace ?? '', token_env: 'ASANA_TOKEN' }, ctx)
    console.log(items.map((i) => `${i.key} ${JSON.stringify(i.fields)}`).join('\n'))
    for (const item of items)
      for (const [key, value] of Object.entries(item.fields))
        for (const v of [value].flat())
          expect(sourceField(asana.fields, key)?.safeParse(v).success).toBe(true)
    const [first] = items
    if (!first) return
    const dir = await mkdtemp(join(tmpdir(), 'nightshift-real-'))
    await asana.prefetch(first, dir, ctx)
    expect(await readdir(dir)).toEqual(['task.md'])
  },
  120_000,
)
