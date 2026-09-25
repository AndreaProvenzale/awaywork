import type { Source } from '../core/types.js'
import { asana } from './asana.js'
import { github } from './github.js'

// biome-ignore lint/suspicious/noExplicitAny: each source narrows its own config
export const sources: Record<string, Source<any>> = { github, asana }
