import type { Config } from '../config/schema.js'
import type { Provider } from '../core/types.js'
import { claude } from './claude.js'
import { codex } from './codex.js'
import { commandProvider, isCommandProvider } from './command.js'

export const providers: Record<string, Provider> = { claude, codex }

/** The built-in provider with this id, else the command provider its config describes. */
export function providerFor(id: string, cfg: unknown): Provider | undefined {
  if (Object.hasOwn(providers, id)) return providers[id]
  return isCommandProvider(cfg) ? commandProvider(id, cfg) : undefined
}

/** The built-in providers and the command providers a config defines. */
export function providersOf(config: Config): Record<string, Provider> {
  const custom = config.providers.flatMap((p) => providerFor(p.id, p.config) ?? [])
  return { ...providers, ...Object.fromEntries(custom.map((p) => [p.id, p])) }
}
