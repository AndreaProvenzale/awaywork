import type { Config } from '../config/schema.js'
import { globToRegExp } from '../core/glob.js'

type Settings = Config['repos'][string]

const isGlob = (key: string) => key.includes('*')

/** Whether a `repos` key names the repo: awaywork works in no other. */
export const repoListed = (repos: Record<string, unknown>, repo: string): boolean =>
  Object.keys(repos).some((key) => globToRegExp(key).test(repo))

/** A repo's settings: those of every `repos` key naming it, globs in the order written and its own key last, a later one winning per setting; secrets add up and gates merge by name. */
export function settingsFor(repos: Record<string, Settings>, repo: string): Settings {
  const keys = Object.keys(repos).filter((key) => globToRegExp(key).test(repo))
  const named = [...keys.filter(isGlob), ...keys.filter((key) => !isGlob(key))].map(
    (key) => repos[key] as Settings,
  )
  return {
    ...Object.assign({}, ...named),
    secrets: [...new Set(named.flatMap((s) => s.secrets))],
    gates: Object.assign({}, ...named.map((s) => s.gates)),
  }
}
