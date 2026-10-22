import type { Config } from '../config/schema.js'
import type { Forge } from '../core/types.js'
import { bitbucketForge, bitbucketWorkspaces } from './bitbucket.js'
import { githubForge, githubHost } from './github.js'

/** The forge of the configured forge source; GitHub when there is none. */
export const forgeFor = (config: Config): Forge =>
  config.sources.bitbucket
    ? bitbucketForge(bitbucketWorkspaces(config))
    : githubForge(undefined, githubHost(config))
