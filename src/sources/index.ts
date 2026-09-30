import type { z } from 'zod'
import type { Source } from '../core/types.js'
import { asana } from './asana.js'
import { commandSource, isCommand } from './command.js'
import { github } from './github.js'
import { jira } from './jira.js'
import { linear } from './linear.js'

// biome-ignore lint/suspicious/noExplicitAny: each source narrows its own config
export const sources: Record<string, Source<any>> = { github, asana, linear, jira }

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
