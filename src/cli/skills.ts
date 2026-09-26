import { existsSync } from 'node:fs'
import { cp } from 'node:fs/promises'
import { join } from 'node:path'
import type { Command } from 'commander'
import { builtinSkillsDir, userSkillsDir } from '../config/paths.js'
import { loadSkills } from '../config/skills.js'

export function skillsCommand(program: Command): void {
  const skills = program.command('skills').description('list skills and eject built-ins to tweak')

  skills
    .command('list')
    .description('skills a rule can name, where each comes from and its delivery default')
    .action(async () => {
      console.log(await listSkills())
    })

  skills
    .command('eject <name>')
    .description(`copy a built-in skill to ${userSkillsDir}, where it shadows the built-in`)
    .action(async (name: string) => {
      try {
        console.log(`Copied to ${await ejectSkill(name)}; edit its SKILL.md there`)
      } catch (e) {
        console.error((e as Error).message)
        process.exitCode = 1
      }
    })
}

export async function listSkills(userDir = userSkillsDir, builtinDir = builtinSkillsDir) {
  const user = await loadSkills(userDir)
  const builtin = await loadSkills(builtinDir)
  const names = [...new Set([...Object.keys(user), ...Object.keys(builtin)])].sort()
  const lines = names.map((name) => {
    const meta = user[name] ?? builtin[name]
    const origin = !user[name] ? 'built-in' : builtin[name] ? 'user, shadows built-in' : 'user'
    const deliver = meta?.deliver ?? 'draft_pr'
    return `${name} (${origin}, ${deliver})\n  ${meta?.description ?? ''}`.trimEnd()
  })
  const footer = [
    `User skills: ${userDir}`,
    'In-repo skills in .night-shift/skills/ resolve at run time, between user and built-in.',
  ]
  return [...lines, '', ...footer].join('\n')
}

export async function ejectSkill(
  name: string,
  userDir = userSkillsDir,
  builtinDir = builtinSkillsDir,
) {
  const from = join(builtinDir, name)
  const to = join(userDir, name)
  if (!existsSync(join(from, 'SKILL.md'))) throw new Error(`no built-in skill "${name}"`)
  if (existsSync(to)) throw new Error(`${to} already exists`)
  await cp(from, to, { recursive: true })
  return to
}
