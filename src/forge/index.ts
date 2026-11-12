import type { Config } from '../config/schema.js'
import type { Forge } from '../core/types.js'
import { githubThreads } from '../sources/github.js'
import { bitbucketForge, bitbucketWorkspaces } from './bitbucket.js'
import { githubForge, githubHost } from './github.js'

/** The config's forge; GitHub comes with its thread issues. */
export const forgeFor = (config: Config): Forge =>
  config.forge.id === 'bitbucket'
    ? bitbucketForge(bitbucketWorkspaces(config))
    : {
        ...githubForge(undefined, githubHost(config)),
        threads: githubThreads(undefined, githubHost(config)),
      }

/** The repo's web page on the configured forge. */
export const repoUrl = (config: Config, repo: string): string =>
  config.forge.id === 'bitbucket'
    ? `https://bitbucket.org/${repo}`
    : `https://${githubHost(config) ?? 'github.com'}/${repo}`
