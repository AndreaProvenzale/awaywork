import { existsSync, readFileSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { parse, stringify } from 'yaml'

export const DEFAULT_PROFILE = 'default'
const NAME = /^[a-z0-9][a-z0-9-]*$/

/** `profiles.yml`: the profile `switch` made current, and where each named profile's config is. */
export interface Registry {
  current?: string
  profiles: Record<string, string>
}

export interface Profile {
  name: string
  /** The config file of a named profile; the default profile's is the usual one. */
  config?: string
  /** Why the profile asked for isn't in force; the default one is. */
  problem?: string
}

/** The registry at `path`, empty when there is none; a file it can't read is an error, never an empty one. */
export function readRegistry(path: string): Registry {
  if (!existsSync(path)) return { current: undefined, profiles: {} }
  const refuse = (why: string) => new Error(`${path}: ${why}`)
  let doc: Partial<Registry> | null
  try {
    doc = parse(readFileSync(path, 'utf8'))
  } catch (e) {
    throw refuse((e as Error).message.split('\n')[0]?.replace(/:$/, '') as string)
  }
  if (doc === null) return { current: undefined, profiles: {} }
  if (typeof doc !== 'object' || Array.isArray(doc)) throw refuse('not a mapping')
  const { current, profiles = {} } = doc
  if (current != null && typeof current !== 'string') throw refuse('current: not a name')
  if (typeof profiles !== 'object' || profiles === null || Array.isArray(profiles))
    throw refuse('profiles: not a mapping')
  for (const [name, config] of Object.entries(profiles)) {
    if (!NAME.test(name)) throw refuse(`${name} isn't a profile name`)
    if (typeof config !== 'string') throw refuse(`${name}: not a config path`)
  }
  return { current: current ?? undefined, profiles }
}

const unknown = (name: string) =>
  `no profile ${name}; awaywork switch ${name} <config> registers it`

/** The profile in force: `AWAYWORK_PROFILE`, else the registry's current one, else the default. */
export function resolveProfile(fromEnv: string | undefined, registry: Registry): Profile {
  const name = fromEnv || registry.current || DEFAULT_PROFILE
  if (name === DEFAULT_PROFILE) return { name }
  const config = Object.hasOwn(registry.profiles, name) ? registry.profiles[name] : undefined
  if (config) return { name, config }
  return { name: DEFAULT_PROFILE, problem: unknown(name) }
}

/** Registers the absolute `config` as `name` when given, then makes `name` current. */
export async function switchTo(path: string, name: string, config?: string): Promise<Registry> {
  const registry = readRegistry(path)
  if (!NAME.test(name))
    throw new Error(`${name} isn't a profile name: lowercase letters, digits and -, like work`)
  if (config !== undefined) {
    if (name === DEFAULT_PROFILE)
      throw new Error('default is always ~/.config/awaywork/config.yml; pick another name')
    if (!existsSync(config)) throw new Error(`${config} doesn't exist`)
    registry.profiles[name] = config
  } else if (name !== DEFAULT_PROFILE && !Object.hasOwn(registry.profiles, name))
    throw new Error(unknown(name))
  registry.current = name
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, stringify(registry))
  return registry
}
