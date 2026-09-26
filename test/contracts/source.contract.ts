import { mkdtemp, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { Ctx, Source } from '../../src/core/types.js'
import { sourceField } from '../../src/sources/index.js'

/** Every source adapter must pass this suite; `rawConfig` is its config as a user writes it. */
export function sourceContract(
  source: Source<unknown>,
  rawConfig: unknown,
  env: Ctx['env'] = {},
): void {
  const ctx: Ctx = { env, log: () => {} }
  describe(`source contract: ${source.id}`, () => {
    const cfg = () => source.configSchema.parse(rawConfig)

    it('declares a usable id, config and secrets', () => {
      expect(source.id).toMatch(/^[a-z][a-z0-9-]*$/)
      expect('type' in source.fields).toBe(false)
      for (const name of source.secrets(cfg())) expect(name).toMatch(/^[A-Z_][A-Z0-9_]*$/)
    })

    it('returns items that carry only declared, valid fields', async () => {
      const items = await source.items(cfg(), ctx)
      expect(items.length).toBeGreaterThan(0)
      for (const item of items) {
        expect(item.source).toBe(source.id)
        expect(['pr', 'issue', 'task']).toContain(item.type)
        expect(item.id && item.key && item.url).toBeTruthy()
        for (const [key, value] of Object.entries(item.fields)) {
          const field = sourceField(source.fields, key)
          expect(field, `undeclared field "${key}"`).toBeDefined()
          for (const v of [value].flat()) expect(field?.safeParse(v).success).toBe(true)
        }
      }
    })

    it('prefetches context files into the given dir', async () => {
      const [item] = await source.items(cfg(), ctx)
      const dir = await mkdtemp(join(tmpdir(), 'nightshift-'))
      if (item) await source.prefetch(item, dir, ctx)
      expect((await readdir(dir)).length).toBeGreaterThan(0)
    })
  })
}
