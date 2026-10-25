import { z } from 'zod'
import { itemStates } from '../core/queue.js'
import type { Source } from '../core/types.js'
import { asana } from './asana.js'
import { bitbucket } from './bitbucket.js'
import { commandSource, isCommand } from './command.js'
import { github } from './github.js'
import { jira } from './jira.js'
import { linear } from './linear.js'

// biome-ignore lint/suspicious/noExplicitAny: each source narrows its own config
export const sources: Record<string, Source<any>> = { github, bitbucket, asana, linear, jira }

/** Keys every item has, whatever its source; a source sets `state`, and `closed` on a finished item. */
export const itemFields: Record<string, z.ZodType> = {
  type: z.enum(['pr', 'issue', 'task']),
  title: z.string(),
  description: z.string(),
  approved: z.boolean(),
  state: z.enum(itemStates),
  closed: z.iso.datetime({ offset: true }),
}

/** The built-in source with this id, else the command source its config describes. */
// biome-ignore lint/suspicious/noExplicitAny: each source narrows its own config
export function sourceFor(id: string, cfg: unknown): Source<any> | undefined {
  return sources[id] ?? (isCommand(cfg) ? commandSource(id, cfg) : undefined)
}

/** The schema a `where` key matches against; a `prefix.*` field declares every `prefix.<name>`. */
export function sourceField(fields: Source['fields'], key: string): z.ZodType | undefined {
  const dot = key.indexOf('.')
  return fields[key] ?? (dot > 0 ? fields[`${key.slice(0, dot)}.*`] : undefined)
}
