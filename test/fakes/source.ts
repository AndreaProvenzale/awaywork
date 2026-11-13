import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import type { Item, Source } from '#core/types'
import { fakeItem } from './items'

const config = z.strictObject({ token_env: z.string().default('FAKE_TOKEN') })

export function fakeSource(items: Item[] = [fakeItem()]): Source<z.infer<typeof config>> {
  return {
    id: 'fake',
    configSchema: config,
    fields: { mine: z.boolean(), checks: z.enum(['failing', 'pending', 'passing']) },
    secrets: (cfg) => [cfg.token_env],
    items: async () => items.map((i) => ({ ...i, fields: { state: 'open', ...i.fields } })),
    prefetch: async (item, dir) => writeFile(join(dir, 'item.md'), item.description),
  }
}
