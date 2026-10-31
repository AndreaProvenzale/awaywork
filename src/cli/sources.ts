import { existsSync, readFileSync } from 'node:fs'
import { parseEnv } from 'node:util'
import type { Command } from 'commander'
import { configPath, loadConfig } from '../config/load.js'
import { envFile } from '../config/paths.js'
import type { Ctx, Discovery, Source } from '../core/types.js'
import { sourceFor, sources } from '../sources/index.js'
import { pad, width } from './format.js'
import { printOutcome } from './skip.js'

export interface Discovered {
  id: string
  /** Where each of its secrets came from, e.g. `LINEAR_API_KEY from ~/.config/awaywork/env`. */
  credentials: string[]
  discovery: Discovery
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
        const found = await discoverSources(id, configured, ctx)
        return opts.json
          ? JSON.stringify(Object.fromEntries(found.map((f) => [f.id, f.discovery])), null, 2)
          : formatDiscovered(found)
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
  file = envFile,
): Promise<Discovered[]> {
  const saved = existsSync(file) ? parseEnv(readFileSync(file, 'utf8')) : {}
  const origin = (name: string) =>
    `${name} from ${Object.hasOwn(saved, name) && saved[name] === ctx.env[name] ? file : 'the environment'}`
  const found: Discovered[] = []
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
    const settings = cfg ?? source.configSchema.partial().parse({})
    const discovery = await source
      .discover(settings, ctx)
      .catch((e: Error & { unset?: string }) => {
        const why = e.unset
          ? `${e.unset} is not set; export it, or add it to ${file} (mode 600)`
          : e.message
        throw new Error(`${each}: ${why}`)
      })
    found.push({ id: each, credentials: source.secrets(settings).map(origin), discovery })
  }
  return found
}

export function formatDiscovered(found: Discovered[]): string {
  if (found.length === 0) return 'No configured source has anything to discover'
  return found
    .map(({ id, credentials, discovery }) =>
      [
        credentials.length > 0 ? `${id}  (${credentials.join(', ')})` : id,
        ...lines(discovery, '  '),
      ].join('\n'),
    )
    .join('\n\n')
}

const isNames = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((v) => typeof v === 'string')

const names = (key: string, value: string[]) => `${key}: ${value.join(', ') || '(none)'}`

/** A value as `key: value`, a list of names inline, a list of records as rows under its key. */
function lines(discovery: Discovery, indent: string): string[] {
  return Object.entries(discovery).flatMap(([key, value]) => {
    if (value === undefined) return []
    if (typeof value === 'string') return [`${indent}${key}: ${value}`]
    if (isNames(value)) return [`${indent}${names(key, value)}`]
    return [`${indent}${key}`, ...rows(value, `${indent}  `)]
  })
}

/** A row per record: its strings as aligned columns, then its lists of names, then its lists of records nested below. */
function rows(records: Discovery[], indent: string): string[] {
  const columns = records.map((r) => Object.values(r).filter((v) => typeof v === 'string'))
  const widest = (i: number) => Math.max(...columns.map((row) => width(row[i] ?? '')))
  return records.flatMap((record, n) => {
    const cells = (columns[n] ?? []).map((cell, i) => pad(cell, widest(i)))
    const entries = Object.entries(record)
    const inline = entries.flatMap(([key, value]) => (isNames(value) ? [names(key, value)] : []))
    const nested = entries.flatMap(([key, value]) =>
      Array.isArray(value) && !isNames(value) ? lines({ [key]: value }, `${indent}  `) : [],
    )
    return [`${indent}${[...cells, ...inline].join('  ')}`.trimEnd(), ...nested]
  })
}
