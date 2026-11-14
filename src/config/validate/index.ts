import type { z } from 'zod'
import type { ConfigShape, ProviderConfig } from '#config/schema'
import { repoListed, settingsFor } from '#plan/repos'
import { providers } from '#providers/index'
import { routines } from '#sources/routines'
import { commandIds, type Issue, issueAt, providerIds } from './issue'
import { checkRule } from './rule'

/** The config's cross-field checks, in the order their issues are reported. */
export function validateConfig(cfg: ConfigShape, ctx: z.RefinementCtx): void {
  const issue = issueAt(ctx)
  checkContainerImages(cfg, issue)
  checkProviders(cfg, issue)
  checkMcpNames(cfg, issue)
  checkSourcesAndForge(cfg, issue)
  checkProvidersListedOnce(cfg, issue)
  cfg.queue?.forEach((r, i) => {
    checkRule(cfg, r, issueAt(ctx, ['queue', i]))
  })
}

/** Under isolation: container, every repo names its image. */
function checkContainerImages(cfg: ConfigShape, issue: Issue) {
  if (cfg.isolation === 'container')
    for (const name of Object.keys(cfg.repos))
      if (!settingsFor(cfg.repos, name).image)
        issue(
          ['repos', name, 'image'],
          'required with isolation: container: the image its units run in',
        )
}

/** A command provider's unit_minutes and name, and a login folder isolation can reach. */
function checkProviders(cfg: ConfigShape, issue: Issue) {
  const commands = commandIds(cfg)
  if (commands.length > 0 && !cfg.limits.unit_minutes)
    issue(
      ['limits', 'unit_minutes'],
      'required with a command provider: it has no turn cap, so this bounds its unit',
    )
  cfg.providers.forEach((entry, i) => {
    for (const [id, settings] of Object.entries(entry as Record<string, ProviderConfig>)) {
      const provider = Object.hasOwn(providers, id) ? providers[id] : undefined
      // Only a login awaywork lends to the worker reaches it; the rest stay in your folders.
      if (settings?.config_dir && cfg.isolation !== 'none' && provider && !provider.login)
        issue(
          ['providers', i, id, 'config_dir'],
          `not with isolation: ${cfg.isolation}, which can't reach your login folder; set ${provider.secrets.join(', ')} instead`,
        )
      if (!commands.includes(id)) continue
      // `constructor` is the one such name Object.prototype already has.
      if (!/^(?!constructor$)[a-z][a-z0-9-]*$/.test(id))
        issue(['providers', i, id], 'expected a lowercase name like opencode')
    }
  })
}

function checkMcpNames(cfg: ConfigShape, issue: Issue) {
  for (const name of Object.keys(cfg.mcp))
    if (!/^[a-z0-9][a-z0-9-]*$/.test(name))
      issue(['mcp', name], 'expected a lowercase name like sentry')
}

/** One forge per config, the repos it needs, and the repos sources name listed in them. */
function checkSourcesAndForge(cfg: ConfigShape, issue: Issue) {
  const bitbucket = cfg.forge.id === 'bitbucket'
  const github = Object.hasOwn(cfg.sources, 'github')
  if (bitbucket && github)
    issue(
      ['sources', 'github'],
      'one forge per config: the github source reads GitHub, and forge is bitbucket',
    )
  if ((bitbucket || github) && Object.keys(cfg.repos).length === 0)
    issue(
      ['repos'],
      `${bitbucket ? 'forge: bitbucket works in' : 'the github source reads'} the repos listed here: add one, e.g. acme/api or acme/*`,
    )
  for (const [id, source] of Object.entries(
    cfg.sources as Record<string, Record<string, unknown>>,
  )) {
    const named =
      id === routines.id
        ? Object.entries(source).map(([name, r]) => [
            name,
            'repo',
            (r as { repo?: unknown } | null)?.repo,
          ])
        : Object.entries(source?.repo_map ?? {}).map(([key, repo]) => ['repo_map', key, repo])
    for (const [at, key, repo] of named) {
      if (typeof repo !== 'string') continue
      const problem = repo.includes('*')
        ? `expected one repo like acme/api, not the pattern ${repo}: a * goes only in a key of repos`
        : !repoListed(cfg.repos, repo) &&
          `${repo} isn't in repos: awaywork works only in the repos listed there, so add it as a key`
      if (problem) issue(['sources', id, at, key], problem)
    }
  }
  for (const name of bitbucket ? Object.keys(cfg.repos) : [])
    if (name.split('/')[0]?.includes('*'))
      issue(['repos', name], 'expected workspace/repo; * globs the repo, never the workspace')
}

function checkProvidersListedOnce(cfg: ConfigShape, issue: Issue) {
  const ids = providerIds(cfg)
  ids.forEach((id, i) => {
    if (ids.indexOf(id) !== i) issue(['providers', i], `"${id}" is listed twice`)
  })
}
