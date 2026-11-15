import { existsSync } from 'node:fs'
import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  builtinSkills,
  parseSkill,
  resolveSkill,
  type SkillCatalog,
  type SkillMeta,
} from '#core/skills'
import type { Rule } from '#core/types'
import { ruleSteps } from '#plan/queue'
import type { Config } from './schema'

/** What the config and the skills beside it say; read once, passed wherever rules are read. */
export interface Setup {
  config: Config
  queue: Rule[]
  catalog: SkillCatalog
}

/** The setup of a config whose skills are already read. */
export const setupOf = (config: Config, catalog: SkillCatalog): Setup => ({
  config,
  queue: config.queue ?? [],
  catalog,
})

/** The config with the user's skills in `dir` and the built-in ones. */
export async function readSetup(config: Config, dir: string): Promise<Setup> {
  return setupOf(config, await readCatalog(dir))
}

/** The user's skills in `dir` and the built-in ones. */
export async function readCatalog(dir: string): Promise<SkillCatalog> {
  return { user: await loadSkills(dir), builtin: builtinSkills }
}

/** Skills in a directory, one folder with a SKILL.md each, linked ones included; a missing directory has none. */
export async function loadSkills(dir: string): Promise<Record<string, SkillMeta>> {
  const names = await readdir(dir).catch(() => [])
  const skills: Record<string, SkillMeta> = {}
  for (const name of names) {
    const text = await readFile(join(dir, name, 'SKILL.md'), 'utf8').catch(() => undefined)
    if (text !== undefined) skills[name] = parseSkill(text)
  }
  return skills
}

/** Whether a directory has a folder with a SKILL.md, linked ones included; parses none. */
export async function hasSkills(dir: string): Promise<boolean> {
  const entries = await readdir(dir).catch(() => [])
  return entries.some((name) => existsSync(join(dir, name, 'SKILL.md')))
}

/** Skills a queue names that are neither the user's nor built in; in-repo skills are only visible at run time. */
export async function unknownSkills(config: Config, userDir: string): Promise<string[]> {
  const catalog = await readCatalog(userDir)
  const problems = config.skills
    .filter((name) => !resolveSkill(name, catalog))
    .map((name) => `skills: unknown skill "${name}" (not built in, not in ${userDir})`)
  const gates = [
    ...Object.entries(config.gates).map(([name, g]) => [`gates.${name}`, g] as const),
    ...Object.entries(config.repos).flatMap(([repo, r]) =>
      Object.entries(r.gates).map(([name, g]) => [`repos.${repo}.gates.${name}`, g] as const),
    ),
    ...(config.queue ?? []).flatMap((r, i) =>
      Object.entries(r.gates ?? {}).map(([name, g]) => [`queue[${i}].gates.${name}`, g] as const),
    ),
  ]
  for (const [at, gate] of gates)
    if (gate.skill && !resolveSkill(gate.skill, catalog))
      problems.push(
        `${at}.skill: unknown skill "${gate.skill}" (not built in, not in ${userDir}; a judge never comes from the repo)`,
      )
  config.queue?.forEach((rule, i) => {
    for (const { step, at: path } of ruleSteps(rule)) {
      const at = `queue[${i}]${path.map((p) => (typeof p === 'number' ? `[${p}]` : `.${p}`)).join('')}`
      for (const name of [step.skill, ...(step.skills ?? [])]) {
        if (resolveSkill(name, catalog)) continue
        problems.push(`${at}: unknown skill "${name}" (not built in, not in ${userDir})`)
      }
    }
  })
  return problems
}

/** Unknown skills as a warning: the unit's repo may have them, and a run fails on any it doesn't. */
export async function unknownSkillsWarning(
  config: Config,
  userDir: string,
): Promise<string | undefined> {
  const unknown = await unknownSkills(config, userDir)
  if (unknown.length === 0) return undefined
  return `${unknown.join('; ')}; fine only if every repo it runs in has it in .awaywork/skills, or as an extra in .claude/skills, .agents/skills or .cursor/skills; a run fails wherever it is missing`
}
