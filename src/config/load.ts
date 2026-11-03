import { readFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { parseDocument } from 'yaml'
import type { z } from 'zod'
import { repoUrl } from '../forge/index.js'
import { isCommandProvider } from '../providers/command.js'
import { isCommand } from '../sources/command.js'
import { routinesOf } from '../sources/routines.js'
import type { ContextSource } from '../worker/context.js'
import { defaultConfigPath } from './paths.js'
import { type Config, configSchema } from './schema.js'

export class ConfigError extends Error {
  constructor(
    readonly path: string,
    readonly problems: string[],
  ) {
    super(`${path}:\n${problems.map((p) => `  ${p}`).join('\n')}`)
  }
}

type Raw = Record<string, unknown>
/** A config file's parsed YAML; a config that extends a base comes first, its base second. */
type Layer = { path: string; raw: unknown }

export function configPath(flag?: string): string {
  const path = flag ?? process.env.AWAYWORK_CONFIG ?? defaultConfigPath
  return path.startsWith('~/') ? join(homedir(), path.slice(2)) : path
}

export async function loadConfig(path: string): Promise<Config> {
  const text = await readFile(path, 'utf8').catch((e: NodeJS.ErrnoException) => {
    throw new ConfigError(path, [e.code === 'ENOENT' ? 'file not found' : e.message])
  })
  const files = layers(text, path)
  const config = validate(files)
  const dirOf = (...keys: string[]) => dirname(resolve(fileOf(files, keys)))
  for (const [id, cfg] of Object.entries(config.sources)) {
    if (isCommand(cfg)) cfg.dir = dirOf('sources', id, 'command')
    const { context } = cfg as ContextSource
    if (context) context.dir = dirOf('sources', id, 'context', 'command')
  }
  for (const { config: cfg } of config.providers)
    if (isCommandProvider(cfg)) cfg.dir = dirOf('providers')
  return config
}

export function parseConfig(text: string, path = '<config>'): Config {
  return validate(layers(text, path))
}

function layers(text: string, path: string): Layer[] {
  const config = { path, raw: yaml(text, path) }
  const base = isRaw(config.raw) ? config.raw.extends : undefined
  if (typeof base !== 'string' || !base) return [config]
  if (/^[a-z][\w+.-]*:\/\//i.test(base))
    throw new ConfigError(path, [`extends: ${base}: expected a path to a file, not a URL`])
  const basePath = isAbsolute(base) ? base : join(dirname(path), base)
  let baseText: string
  try {
    baseText = readFileSync(basePath, 'utf8')
  } catch (e) {
    const { code, message } = e as NodeJS.ErrnoException
    throw new ConfigError(path, [
      `extends: ${code === 'ENOENT' ? `${base}: file not found` : message}`,
    ])
  }
  const raw = yaml(baseText, basePath)
  if (isRaw(raw) && raw.extends !== undefined)
    throw new ConfigError(path, [
      `extends: ${base} has an extends of its own; a base can't extend another config`,
    ])
  if (isRaw(raw)) absolute(raw, dirname(basePath))
  return [config, { path: basePath, raw }]
}

function yaml(text: string, path: string): unknown {
  const doc = parseDocument(text)
  if (doc.errors.length > 0)
    throw new ConfigError(
      path,
      doc.errors.map((e) => e.message),
    )
  return doc.toJS()
}

function validate(files: Layer[]): Config {
  const [config, base] = files as [Layer, Layer?]
  const result = configSchema.safeParse(base ? merge(base.raw, config.raw) : config.raw)
  if (!result.success) {
    const problems = result.error.issues.map((issue) => {
      const keys =
        issue.code === 'unrecognized_keys' ? [...issue.path, ...issue.keys.slice(0, 1)] : issue.path
      return { file: fileOf(files, keys), problem: formatIssue(issue) }
    })
    const { file } = problems[0] as { file: string }
    throw new ConfigError(
      file,
      problems.map((p) => (p.file === file ? p.problem : `${p.file}: ${p.problem}`)),
    )
  }
  for (const [, r] of routinesOf(result.data.sources.routines)) r.url = repoUrl(result.data, r.repo)
  return result.data
}

/** `over` on top of `base`: maps merge key by key; anything else, a list too, replaces. */
function merge(base: unknown, over: unknown): unknown {
  if (!isRaw(base) || !isRaw(over)) return over
  const merged = { ...base }
  for (const [key, value] of Object.entries(over)) merged[key] = merge(base[key], value)
  return merged
}

/** The file that sets `keys`: the config's own, unless its base sets more of the path. */
function fileOf(files: Layer[], keys: readonly PropertyKey[]): string {
  return files.reduce((best, f) => (depth(f.raw, keys) > depth(best.raw, keys) ? f : best)).path
}

/** How many of `keys`, from the first, `raw` has. */
function depth(raw: unknown, keys: readonly PropertyKey[]): number {
  let found = 0
  for (const key of keys) {
    if (typeof raw !== 'object' || raw === null || !Object.hasOwn(raw, key)) break
    raw = (raw as Record<PropertyKey, unknown>)[key]
    found++
  }
  return found
}

/** Makes a base's instruction and settings files absolute, so they resolve against its own folder. */
function absolute(raw: Raw, dir: string): void {
  const resolved = (paths: unknown): unknown =>
    typeof paths === 'string'
      ? resolve(dir, paths)
      : Array.isArray(paths)
        ? paths.map(resolved)
        : paths
  const fix = (o: unknown) => {
    if (isRaw(o) && 'instructions' in o) o.instructions = resolved(o.instructions)
  }
  fix(raw)
  if (isRaw(raw.repos)) Object.values(raw.repos).forEach(fix)
  for (const rule of [raw.queue ?? []].flat()) {
    fix(rule)
    for (const step of isRaw(rule) ? [rule.then ?? []].flat() : [])
      if (isRaw(step) && 'loop' in step) [step.loop].flat().forEach(fix)
      else fix(step)
  }
  for (const entry of [raw.providers ?? []].flat())
    if (isRaw(entry) && isRaw(entry.claude) && 'settings' in entry.claude)
      entry.claude.settings = resolved(entry.claude.settings)
}

const isRaw = (value: unknown): value is Raw =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

function formatIssue(issue: z.core.$ZodIssue): string {
  const at = issue.path
    .map((p, i) => (typeof p === 'number' ? `[${p}]` : i === 0 ? String(p) : `.${String(p)}`))
    .join('')
  // A record key's own message, e.g. `expected owner/name`, sits under zod's generic one.
  const message =
    issue.code === 'invalid_key' ? (issue.issues[0]?.message ?? issue.message) : issue.message
  return at ? `${at}: ${message}` : message
}
