import { z } from 'zod'
import type { Source } from '../core/types.js'

const config = z
  .strictObject({
    repos: z
      .array(
        z
          .string()
          .regex(
            /^[^/*?\s]+\/[^/\s]+$/,
            'expected workspace/repo; * globs the repo, never the workspace',
          ),
      )
      .min(1)
      .describe('Bitbucket Cloud repos, workspace/name; * globs the name, e.g. acme/*'),
  })
  .describe(
    'The forge for Bitbucket Cloud repos, through twg; no items of its own yet, so pair it with a source such as jira',
  )

export const bitbucket: Source<z.infer<typeof config>> = {
  id: 'bitbucket',
  configSchema: config,
  // Its PRs will link themselves.
  link: false,
  fields: {},
  secrets: () => [],
  items: async () => [],
  prefetch: async () => {},
}
