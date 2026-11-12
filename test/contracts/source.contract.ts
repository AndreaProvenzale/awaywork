import { mkdtemp, readdir, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import type { Ctx, Item, Source } from '../../src/core/types.js'
import { itemFields, sourceField } from '../../src/sources/index.js'

/**
 * Every source adapter must pass this suite; `rawConfig` is its config as a
 * user writes it, `move` is where a source that writes moves its first item,
 * and `scope` is what the loaded config adds to its config.
 */
export function sourceContract(
  source: Source<unknown>,
  rawConfig: unknown,
  env: Ctx['env'] = {},
  move?: string,
  scope: object = {},
): void {
  const ctx: Ctx = { env, log: () => {} }
  describe(`source contract: ${source.id}`, () => {
    const cfg = () => ({ ...source.configSchema.parse(rawConfig), ...scope })

    it('declares a usable id, config and secrets', () => {
      expect(source.id).toMatch(/^[a-z][a-z0-9-]*$/)
      for (const key of Object.keys(itemFields)) expect(key in source.fields, key).toBe(false)
      for (const name of source.secrets(cfg())) expect(name).toMatch(/^[A-Z_][A-Z0-9_]*$/)
    })

    it('returns open items that carry only declared, valid fields', async () => {
      const items = await source.items(cfg(), ctx)
      expect(items.length).toBeGreaterThan(0)
      for (const item of items) {
        expect(item.source).toBe(source.id)
        expect(['pr', 'issue', 'task']).toContain(item.type)
        expect(item.id && item.key && item.url).toBeTruthy()
        expect(item.fields.state).toBe('open')
        for (const [key, value] of Object.entries(item.fields)) {
          const field = itemFields[key] ?? sourceField(source.fields, key)
          expect(field, `undeclared field "${key}"`).toBeDefined()
          for (const v of [value].flat()) expect(field?.safeParse(v).success).toBe(true)
        }
      }
    })

    it('prefetches context files into the given dir', async () => {
      const [item] = await source.items(cfg(), ctx)
      const dir = await mkdtemp(join(tmpdir(), 'awaywork-'))
      if (item) await source.prefetch(item, dir, ctx)
      expect((await readdir(dir)).length).toBeGreaterThan(0)
    })

    it.runIf(source.write)("shows awaywork's questions in item.md, then the reply", async () => {
      const [item] = await source.items(cfg(), ctx)
      const comments = [
        { author: 'dev', body: 'Per user?\n\n— awaywork', at: '2026-01-05T08:00:00Z', mine: true },
        { author: 'sam', body: 'Per key.', at: '2026-01-05T09:00:00Z' },
      ] as const
      const dir = await mkdtemp(join(tmpdir(), 'awaywork-'))
      await source.prefetch({ ...(item as Item), comments: [...comments] }, dir, ctx)
      const text = await readFile(join(dir, 'item.md'), 'utf8')
      expect(text).toContain(
        "### awaywork's questions (dev), 2026-01-05T08:00:00Z\n\nPer user?\n\n— awaywork\n\n### sam, 2026-01-05T09:00:00Z\n\nPer key.",
      )
    })

    it.runIf(source.discover)('discovers plain data with its credentials', async () => {
      const found = await source.discover?.(cfg() as Partial<unknown>, ctx)
      expect(found).toBeDefined()
      expect(JSON.parse(JSON.stringify(found))).toEqual(found)
    })

    it.runIf(source.write)(
      'moves its first item to `move`, returning its updated times before and after, or none',
      async () => {
        expect(move, 'a source that writes needs a destination to move to').toBeDefined()
        const [item] = await source.items(cfg(), ctx)
        const written = await source.write?.(
          cfg(),
          item as Item,
          { op: 'move', to: move as string },
          ctx,
        )
        for (const time of [written?.before, written?.after].filter((t) => t !== undefined))
          expect(z.iso.datetime().safeParse(time).success, `not an ISO time: ${time}`).toBe(true)
      },
    )
  })
}
