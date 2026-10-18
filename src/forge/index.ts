import type { Config } from '../config/schema.js'
import type { Forge } from '../core/types.js'
import { githubForge, githubHost } from './github.js'

/** Always GitHub until a second forge exists. */
export const forgeFor = (config: Config): Forge => githubForge(undefined, githubHost(config))
