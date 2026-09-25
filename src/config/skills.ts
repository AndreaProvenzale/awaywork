import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { userSkillsDir } from './paths.js'
import type { Config } from './schema.js'

export const builtinSkills = [
  'fix-ci',
  'address-review',
  'qa-feedback',
  'continue',
  'plan',
  'implement',
  'review',
]

/** Skills a queue names that are neither the user's nor built in; in-repo skills are only visible at run time. */
export function unknownSkills(config: Config, userDir = userSkillsDir): string[] {
  const problems: string[] = []
  config.queue?.forEach((rule, i) => {
    for (const name of [rule.skill, ...rule.skills]) {
      if (builtinSkills.includes(name) || existsSync(join(userDir, name, 'SKILL.md'))) continue
      problems.push(`queue[${i}]: unknown skill "${name}" (not built in, not in ${userDir})`)
    }
  })
  return problems
}
