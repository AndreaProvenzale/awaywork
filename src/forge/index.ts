import type { Config } from '../config/schema.js'
import type { Forge } from '../core/types.js'
import { githubForge, githubHost } from './github.js'

/** The forge of the config's forge source; GitHub is the only one so far, and the default. */
export const forgeFor = (config: Config): Forge => githubForge(undefined, githubHost(config))
