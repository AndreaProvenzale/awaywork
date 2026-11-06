import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { Provider } from '../core/types.js'
import { type Exec, exec } from '../forge/gh.js'
import { providers } from '../providers/index.js'
import type { Config } from './schema.js'

/** A login the config pins: the env var it sets to `value`, or unsets, unless the environment's own login wins (`by`) or it can't (`problem`, with the fix). */
export interface Pin {
  /** The provider's id, or `gh`. */
  what: string
  /** Where the config pins it, e.g. `sources.github.user`. */
  key: string
  name: string
  value?: string
  /** The env var whose login wins over the pin. */
  by?: string
  problem?: string
}

/** Each env's values from before awaywork pinned them, so a config loaded again pins afresh. */
const before = new WeakMap<NodeJS.ProcessEnv, Map<string, string | undefined>>()

/** Whether `name` holds a login awaywork pinned rather than one from the environment. */
export const pinned = (env: NodeJS.ProcessEnv, name: string) => before.get(env)?.has(name) ?? false

export const expandHome = (path: string) =>
  path.startsWith('~/') ? join(homedir(), path.slice(2)) : path

/**
 * Points `env` at the logins the config pins, each provider's `config_dir` and `sources.github.user`'s gh account,
 * where the environment brings no login of its own. Returns every pin, the ones it couldn't make included.
 */
export async function pinLogins(
  config: Config,
  env: NodeJS.ProcessEnv = process.env,
  run: Exec = exec,
): Promise<Pin[]> {
  const was = before.get(env) ?? new Map<string, string | undefined>()
  before.set(env, was)
  for (const [name, value] of was) set(env, name, value)
  was.clear()
  const gh = await ghPin(config, env, run)
  const pins = [...providerPins(config, env), ...(gh ? [gh] : [])]
  for (const pin of pins) {
    if (pin.by || pin.problem) continue
    was.set(pin.name, env[pin.name])
    set(env, pin.name, pin.value)
  }
  return pins
}

function set(env: NodeJS.ProcessEnv, name: string, value: string | undefined): void {
  if (value === undefined) delete env[name]
  else env[name] = value
}

function providerPins(config: Config, env: NodeJS.ProcessEnv): Pin[] {
  return config.providers.flatMap(({ id, config_dir: dir }, i): Pin[] => {
    const provider = Object.hasOwn(providers, id) ? providers[id] : undefined
    const login = provider?.loginDir
    if (!dir || !provider || !login) return []
    const pin = { what: id, key: `providers[${i}].${id}.config_dir`, name: login.env }
    const by = provider.secrets.find((name) => env[name])
    if (by) return [{ ...pin, by }]
    const path = expandHome(dir)
    if (!existsSync(path))
      return [
        { ...pin, problem: `${dir} doesn't exist; log in there with ${loginCommand(login, dir)}` },
      ]
    // Claude Code keys its keychain login by the folder: its own default, named, finds none.
    return [{ ...pin, value: path === expandHome(login.default) ? undefined : path }]
  })
}

/** How to log in to the folder `dir`: as is for the provider's default folder. */
export const loginCommand = (login: NonNullable<Provider['loginDir']>, dir: string) =>
  expandHome(dir) === expandHome(login.default)
    ? login.command
    : `${login.env}=${dir} ${login.command}`

async function ghPin(config: Config, env: NodeJS.ProcessEnv, run: Exec): Promise<Pin | undefined> {
  const github = config.sources.github as { user?: string; host?: string } | undefined
  if (!github?.user) return
  const { user, host } = github
  const names = host
    ? ['GH_ENTERPRISE_TOKEN', 'GITHUB_ENTERPRISE_TOKEN']
    : ['GH_TOKEN', 'GITHUB_TOKEN']
  const pin = { what: 'gh', key: 'sources.github.user', name: names[0] as string }
  const by = names.find((name) => env[name])
  if (by) return { ...pin, by }
  const hostname = host ? ['--hostname', host] : []
  const token = (
    await run('gh', ['auth', 'token', '--user', user, ...hostname]).catch(() => '')
  ).trim()
  if (token) return { ...pin, value: token }
  const on = host ? ` on ${host}` : ''
  return {
    ...pin,
    problem: `${user} isn't logged in to gh${on}; log in with gh auth login${host ? ` --hostname ${host}` : ''}, as ${user}`,
  }
}
