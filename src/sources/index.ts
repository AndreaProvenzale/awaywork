import type { z } from 'zod'
import type { Source } from '../core/types.js'
import { asana } from './asana.js'
import { github } from './github.js'

// biome-ignore lint/suspicious/noExplicitAny: each source narrows its own config
export const sources: Record<string, Source<any>> = { github, asana }

/** The schema a `where` key matches against; a `prefix.*` field declares every `prefix.<name>`. */
export function sourceField(fields: Source['fields'], key: string): z.ZodType | undefined {
  const dot = key.indexOf('.')
  return fields[key] ?? (dot > 0 ? fields[`${key.slice(0, dot)}.*`] : undefined)
}
