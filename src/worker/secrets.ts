import type { Config } from '#config/schema'
import type { Provider, Source } from '#core/types'
import { contextSecrets } from './context'

/** Every secret the config names, for `workerEnv` to withhold. */
export function configSecrets(
  config: Config,
  providers: Record<string, Provider>,
  sources: Record<string, Source>,
): string[] {
  return [
    ...Object.values(providers).flatMap((p) => p.secrets),
    ...Object.entries(config.sources).flatMap(([id, cfg]) => sources[id]?.secrets(cfg) ?? []),
    ...contextSecrets(config),
    ...(config.notify?.secrets ?? []),
    ...(config.store?.secrets ?? []),
    ...Object.values(config.repos).flatMap((r) => r.secrets),
    ...Object.values(config.mcp).flatMap((s) => s.secrets),
  ]
}
