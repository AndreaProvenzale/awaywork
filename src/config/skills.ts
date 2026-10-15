import { existsSync } from 'node:fs'
import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { ruleSteps } from '../core/queue.js'
import { builtinSkills, parseSkill, resolveSkill, type SkillMeta } from '../core/skills.js'
import type { Config } from './schema.js'

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
  const catalog = { user: await loadSkills(userDir), builtin: builtinSkills }
  const problems = config.skills
    .filter((name) => !resolveSkill(name, catalog))
    .map((name) => `skills: unknown skill "${name}" (not built in, not in ${userDir})`)
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
  return `${unknown.join('; ')}; fine for a skill the repo has in .awaywork/skills, or for an extra one in .claude/skills or .agents/skills; a run fails on one that is in none`
}
