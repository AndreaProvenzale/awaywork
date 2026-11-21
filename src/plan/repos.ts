import type { Config } from '#config/schema'
import { globToRegExp } from '#util/glob'

type Settings = Config['repos'][string]

const isGlob = (key: string) => key.includes('*')

/** Whether a `repos` key names the repo: awaywork works in no other. */
export const repoListed = (repos: Record<string, unknown>, repo: string): boolean =>
  Object.keys(repos).some((key) => globToRegExp(key).test(repo))

/** The authors the top level and every `repos` key naming the repo trust. */
export const trustFor = (config: Pick<Config, 'trust' | 'repos'>, repo: string): string[] => [
  ...new Set([...config.trust, ...settingsFor(config.repos, repo).trust]),
]

/** A repo's settings: those of every `repos` key naming it, globs in the order written and its own key last, a later one winning per setting; secrets, network hosts, writable paths and trusted authors add up and gates merge by name. */
export function settingsFor(repos: Record<string, Settings>, repo: string): Settings {
  const keys = Object.keys(repos).filter((key) => globToRegExp(key).test(repo))
  const named = [...keys.filter(isGlob), ...keys.filter((key) => !isGlob(key))].map(
    (key) => repos[key] as Settings,
  )
  return {
    ...Object.assign({}, ...named),
    secrets: [...new Set(named.flatMap((s) => s.secrets))],
    network: [...new Set(named.flatMap((s) => s.network))],
    trust: [...new Set(named.flatMap((s) => s.trust))],
    writable: [...new Set(named.flatMap((s) => s.writable))],
    gates: Object.assign({}, ...named.map((s) => s.gates)),
  }
}
