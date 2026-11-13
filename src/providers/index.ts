import type { Config } from '#config/schema'
import type { Provider } from '#core/types'
import { claude } from './claude'
import { codex } from './codex'
import { commandProvider, isCommandProvider } from './command'
import { cursor } from './cursor'

export const providers: Record<string, Provider> = { claude, codex, cursor }

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
