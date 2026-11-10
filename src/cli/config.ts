import { existsSync } from 'node:fs'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import type { Command } from 'commander'
import { execa } from 'execa'
import { z } from 'zod'
import { ConfigError, configPath, loadConfig, parseConfig } from '../config/load.js'
import { skillsDirOf } from '../config/paths.js'
import { configSchema } from '../config/schema.js'
import { loadSkills, unknownSkillsWarning } from '../config/skills.js'
import { builtinSkills } from '../core/skills.js'
import { printBrand, terminalAsk } from './ask.js'
import { explainConfig } from './explain.js'
import { staleSchedules } from './schedule.js'

export function configCommand(program: Command): void {
  const config = program
    .command('config')
    .description("print the config's path or its schema, or edit the config")

  config
    .command('path')
    .description('print the config file awaywork reads; exit 1 when it does not exist')
    .action(() => {
      const path = configPath(program.opts().config)
      console.log(path)
      if (existsSync(path)) return
      console.error(`${path} not found; awaywork init writes one`)
      process.exitCode = 1
    })

  config
    .command('explain')
    .description('print what the config says as JSON, without reading a source or a provider')
    .action(async () => {
      const path = configPath(program.opts().config)
      const text = await readFile(path, 'utf8').catch(() => undefined)
      if (text === undefined) {
        console.error(`${path} not found; awaywork init writes one`)
        process.exitCode = 1
        return
      }
      // A broken SKILL.md is the run's problem; the rules still read, from the built-in logic.
      const user = await loadSkills(skillsDirOf(path)).catch(() => ({}))
      const skills = { user, builtin: builtinSkills }
      console.log(JSON.stringify(explainConfig(text, path, skills), null, 2))
    })

  config
    .command('schema')
    .description('print the config JSON Schema, for editor autocompletion')
    .action(() => {
      console.log(JSON.stringify(z.toJSONSchema(configSchema, { io: 'input' }), null, 2))
    })

  config
    .command('edit')
    .description('open the config in $VISUAL or $EDITOR; it is saved only once valid')
    .action(async () => {
      const path = configPath(program.opts().config)
      const original = await readFile(path, 'utf8').catch(() => undefined)
      if (original === undefined) {
        console.error(`${path} not found; awaywork init writes one`)
        process.exitCode = 1
        return
      }
      printBrand()
      const draft = join(await mkdtemp(join(tmpdir(), 'awaywork-')), basename(path))
      const [bin = 'vi', ...args] = (process.env.VISUAL || process.env.EDITOR || 'vi').split(' ')
      const outcome = await editUntilValid({
        path,
        original,
        draft,
        edit: async () => void (await execa(bin, [...args, draft], { stdio: 'inherit' })),
        retry: (e) => {
          console.error(e.message)
          return terminalAsk.confirm('Edit again? No keeps the saved config as it was')
        },
      })
      console.log(
        {
          saved: `Saved ${path}`,
          unchanged: 'No change',
          discarded: `Not saved; the draft is in ${draft}`,
        }[outcome],
      )
      if (outcome === 'saved') {
        const config = await loadConfig(path, { pin: false })
        const unknown = await unknownSkillsWarning(config, skillsDirOf(path))
        if (unknown) console.error(`warning: ${unknown}`)
        for (const warning of await staleSchedules(path, config.windows))
          console.error(`warning: ${warning}`)
      }
    })
}

/** Edits a draft copy until it validates, then writes it over the config. */
export async function editUntilValid(input: {
  path: string
  original: string
  draft: string
  edit(): Promise<void>
  retry(e: ConfigError): Promise<boolean>
}): Promise<'saved' | 'unchanged' | 'discarded'> {
  await writeFile(input.draft, input.original)
  for (;;) {
    await input.edit()
    const text = await readFile(input.draft, 'utf8')
    if (text === input.original) return 'unchanged'
    try {
      parseConfig(text, input.path)
      await writeFile(input.path, text)
      return 'saved'
    } catch (e) {
      if (!(e instanceof ConfigError)) throw e
      if (!(await input.retry(e))) return 'discarded'
    }
  }
}
