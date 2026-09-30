import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { ruleSteps } from '../core/queue.js'
import { builtinSkills, parseSkill, resolveSkill, type SkillMeta } from '../core/skills.js'
import { userSkillsDir } from './paths.js'
import type { Config } from './schema.js'

/** Skills in a directory, one folder with a SKILL.md each; a missing directory has none. */
export async function loadSkills(dir: string): Promise<Record<string, SkillMeta>> {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => [])
  const skills: Record<string, SkillMeta> = {}
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const text = await readFile(join(dir, entry.name, 'SKILL.md'), 'utf8').catch(() => undefined)
    if (text !== undefined) skills[entry.name] = parseSkill(text)
  }
  return skills
}

/** Skills a queue names that are neither the user's nor built in; in-repo skills are only visible at run time. */
export async function unknownSkills(config: Config, userDir = userSkillsDir): Promise<string[]> {
  const catalog = { user: await loadSkills(userDir), builtin: builtinSkills }
  const problems = config.skills
    .filter((name) => !resolveSkill(name, catalog))
    .map((name) => `skills: unknown skill "${name}" (not built in, not in ${userDir})`)
  config.queue?.forEach((rule, i) => {
    for (const { step, at: path } of ruleSteps(rule)) {
      const at = `queue[${i}]${path.map((p) => (typeof p === 'number' ? `[${p}]` : `.${p}`)).join('')}`
      for (const name of [step.skill, ...step.skills]) {
        if (resolveSkill(name, catalog)) continue
        problems.push(`${at}: unknown skill "${name}" (not built in, not in ${userDir})`)
      }
    }
  })
  return problems
}
