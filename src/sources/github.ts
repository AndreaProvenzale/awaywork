import { z } from 'zod'
import { notImplemented } from '../core/not-implemented.js'
import type { Source } from '../core/types.js'

const config = z.strictObject({ repos: z.array(z.string()).min(1) })

export const github: Source<z.infer<typeof config>> = {
  id: 'github',
  configSchema: config,
  fields: {
    repo: z.string(),
    label: z.string(),
    author: z.string(),
    mine: z.boolean(),
    draft: z.boolean(),
    checks: z.enum(['failing', 'pending', 'passing']),
    unresolved_threads: z.number().int().min(0),
    review_requested: z.boolean(),
  },
  secrets: () => [],
  items: () => notImplemented('github.items', 'M2'),
  prefetch: () => notImplemented('github.prefetch', 'M2'),
}
