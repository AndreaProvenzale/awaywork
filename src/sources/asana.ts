import { z } from 'zod'
import { notImplemented } from '../core/not-implemented.js'
import type { Source } from '../core/types.js'

const config = z.strictObject({
  workspace: z.string(),
  projects: z.array(z.string()).optional(),
  token_env: z.string().default('ASANA_TOKEN'),
})

export const asana: Source<z.infer<typeof config>> = {
  id: 'asana',
  configSchema: config,
  fields: {
    project: z.string(),
    section: z.string(),
    tags: z.string(),
  },
  secrets: (cfg) => [cfg.token_env],
  items: async () => notImplemented('asana.items', 'M6'),
  prefetch: async () => notImplemented('asana.prefetch', 'M6'),
}
