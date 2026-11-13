import type { Config } from '#config/schema'
import type { Forge } from '#core/types'
import { githubThreads } from '#sources/github'
import { bitbucketForge, bitbucketWorkspaces } from './bitbucket'
import { githubForge, githubHost } from './github'

/** The config's forge; GitHub comes with its thread issues. */
export const forgeFor = (config: Config): Forge =>
  config.forge.id === 'bitbucket'
    ? bitbucketForge(bitbucketWorkspaces(config))
    : {
        ...githubForge(undefined, githubHost(config)),
        threads: githubThreads(undefined, githubHost(config), config.repos),
      }

/** The repo's web page on the configured forge. */
export const repoUrl = (config: Config, repo: string): string =>
  config.forge.id === 'bitbucket'
    ? `https://bitbucket.org/${repo}`
    : `https://${githubHost(config) ?? 'github.com'}/${repo}`
