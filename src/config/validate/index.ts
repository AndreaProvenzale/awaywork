import type { z } from 'zod'
import type { ParsedConfig, ProviderConfig } from '#config/schema'
import { repoListed, settingsFor } from '#plan/repos'
import { providers } from '#providers/index'
import { routines } from '#sources/routines'
import { checkRule } from './rule'

/** The config's cross-field checks, in the order their issues are reported. */
export function validateConfig(cfg: ParsedConfig, ctx: z.RefinementCtx): void {
  checkContainerImages(cfg, ctx)
  const providerIds = cfg.providers.flatMap(Object.keys)
  const commandIds = providerIds.filter((id) => !Object.hasOwn(providers, id))
  checkProviders(cfg, ctx, commandIds)
  checkMcpNames(cfg, ctx)
  const sourceIds = Object.keys(cfg.sources)
  const bitbucket = cfg.forge.id === 'bitbucket'
  checkSourcesAndForge(cfg, ctx, sourceIds, bitbucket)
  checkProvidersListedOnce(ctx, providerIds)
  const known = { providerIds, commandIds, sourceIds, bitbucket }
  cfg.queue?.forEach((r, i) => {
    checkRule(cfg, ctx, r, i, known)
  })
}

/** Under isolation: container, every repo names its image. */
function checkContainerImages(cfg: ParsedConfig, ctx: z.RefinementCtx) {
  if (cfg.isolation === 'container')
    for (const name of Object.keys(cfg.repos))
      if (!settingsFor(cfg.repos, name).image)
        ctx.addIssue({
          code: 'custom',
          path: ['repos', name, 'image'],
          message: 'required with isolation: container: the image its units run in',
        })
}

/** A command provider's unit_minutes and name, and a login folder isolation can reach. */
function checkProviders(cfg: ParsedConfig, ctx: z.RefinementCtx, commandIds: string[]) {
  if (commandIds.length > 0 && !cfg.limits.unit_minutes)
    ctx.addIssue({
      code: 'custom',
      path: ['limits', 'unit_minutes'],
      message: 'required with a command provider: it has no turn cap, so this bounds its unit',
    })
  cfg.providers.forEach((entry, i) => {
    for (const [id, settings] of Object.entries(entry as Record<string, ProviderConfig>)) {
      const provider = Object.hasOwn(providers, id) ? providers[id] : undefined
      // Only a login awaywork lends to the worker reaches it; the rest stay in your folders.
      if (settings?.config_dir && cfg.isolation !== 'none' && provider && !provider.login)
        ctx.addIssue({
          code: 'custom',
          path: ['providers', i, id, 'config_dir'],
          message: `not with isolation: ${cfg.isolation}, which can't reach your login folder; set ${provider.secrets.join(', ')} instead`,
        })
      if (!commandIds.includes(id)) continue
      // `constructor` is the one such name Object.prototype already has.
      if (!/^(?!constructor$)[a-z][a-z0-9-]*$/.test(id))
        ctx.addIssue({
          code: 'custom',
          path: ['providers', i, id],
          message: 'expected a lowercase name like opencode',
        })
    }
  })
}

function checkMcpNames(cfg: ParsedConfig, ctx: z.RefinementCtx) {
  for (const name of Object.keys(cfg.mcp))
    if (!/^[a-z0-9][a-z0-9-]*$/.test(name))
      ctx.addIssue({
        code: 'custom',
        path: ['mcp', name],
        message: 'expected a lowercase name like sentry',
      })
}

/** One forge per config, the repos it needs, and the repos sources name listed in them. */
function checkSourcesAndForge(
  cfg: ParsedConfig,
  ctx: z.RefinementCtx,
  sourceIds: string[],
  bitbucket: boolean,
) {
  if (bitbucket && sourceIds.includes('github'))
    ctx.addIssue({
      code: 'custom',
      path: ['sources', 'github'],
      message: 'one forge per config: the github source reads GitHub, and forge is bitbucket',
    })
  if ((bitbucket || sourceIds.includes('github')) && Object.keys(cfg.repos).length === 0)
    ctx.addIssue({
      code: 'custom',
      path: ['repos'],
      message: `${bitbucket ? 'forge: bitbucket works in' : 'the github source reads'} the repos listed here: add one, e.g. acme/api or acme/*`,
    })
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
      if (problem)
        ctx.addIssue({ code: 'custom', path: ['sources', id, at, key], message: problem })
    }
  }
  for (const name of bitbucket ? Object.keys(cfg.repos) : [])
    if (name.split('/')[0]?.includes('*'))
      ctx.addIssue({
        code: 'custom',
        path: ['repos', name],
        message: 'expected workspace/repo; * globs the repo, never the workspace',
      })
}

function checkProvidersListedOnce(ctx: z.RefinementCtx, providerIds: string[]) {
  providerIds.forEach((id, i) => {
    if (providerIds.indexOf(id) !== i)
      ctx.addIssue({ code: 'custom', path: ['providers', i], message: `"${id}" is listed twice` })
  })
}
