import { existsSync } from 'node:fs'
import type { Command } from 'commander'
import { stringify } from 'yaml'
import { configPath, loadConfig } from '../config/load.js'
import { envFile } from '../config/paths.js'
import type { Ctx, Discovery, Source } from '../core/types.js'
import { sourceFor, sources } from '../sources/index.js'
import { printOutcome } from './skip.js'

export interface Discoveries {
  found: { id: string; discovery: Discovery }[]
  /** `<id>: <why>` for each source that couldn't tell. */
  failed: string[]
}

export function sourcesCommand(program: Command): void {
  program
    .command('sources [id]')
    .description(
      "list what a source's credentials can see (workspaces, projects, teams, statuses), read-only; with no id, every configured source",
    )
    .option('--json', 'print one object keyed by source id')
    .action((id: string | undefined, opts: { json?: boolean }) =>
      printOutcome(async () => {
        const path = configPath(program.opts().config)
        if (!id && !existsSync(path))
          throw new Error(`no config at ${path}; name a source, e.g. awaywork sources github`)
        const configured = existsSync(path) ? (await loadConfig(path)).sources : {}
        const ctx: Ctx = { env: process.env, log: (line) => console.error(line) }
        return formatDiscoveries(await discoverSources(id, configured, ctx), opts.json)
      }),
    )
}

/**
 * What the named source's credentials can see, or every configured source's that can tell.
 * A source not in the config gets its schema's defaults, which is enough for those that need no settings.
 */
export async function discoverSources(
  id: string | undefined,
  configured: Record<string, unknown>,
  ctx: Ctx,
  // biome-ignore lint/suspicious/noExplicitAny: each source narrows its own config
  registry: Record<string, Source<any>> = sources,
): Promise<Discoveries> {
  const result: Discoveries = { found: [], failed: [] }
  for (const each of id ? [id] : Object.keys(configured)) {
    const cfg = configured[each]
    const source = registry[each] ?? sourceFor(each, cfg)
    if (!source)
      throw new Error(
        `no source "${each}": the config has none, and the built-in ones are ${Object.keys(registry).join(', ')}`,
      )
    if (!source.discover) {
      if (id) throw new Error(`${each} has nothing to discover`)
      continue
    }
    try {
      const discovery = await source.discover(cfg ?? source.configSchema.partial().parse({}), ctx)
      result.found.push({ id: each, discovery })
    } catch (e) {
      const { message, unset } = e as Error & { unset?: string }
      const why = unset
        ? `${unset} is not set; export it, or add it to ${envFile} (mode 600)`
        : message
      result.failed.push(`${each}: ${why}`)
    }
  }
  return result
}

/** The sources that told, as YAML or JSON; the failures go to stderr and fail the command. */
export function formatDiscoveries({ found, failed }: Discoveries, json?: boolean): string {
  if (failed.length > 0) {
    if (found.length === 0) throw new Error(failed.join('\n'))
    console.error(failed.join('\n'))
    process.exitCode = 1
  }
  const byId = Object.fromEntries(found.map((f) => [f.id, f.discovery]))
  if (json) return JSON.stringify(byId, null, 2)
  return found.length > 0
    ? stringify(byId).trimEnd()
    : 'No configured source has anything to discover'
}
