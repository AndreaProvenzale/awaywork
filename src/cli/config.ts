import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import type { Command } from 'commander'
import { z } from 'zod'
import { configPath } from '../config/load.js'
import { skillsDirOf } from '../config/paths.js'
import { configSchema } from '../config/schema.js'
import { loadSkills } from '../config/skills.js'
import { builtinSkills } from '../core/skills.js'
import { explainConfig } from './explain.js'

export function configCommand(program: Command): void {
  const config = program
    .command('config')
    .description("print the config's path, what it says or its schema")

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
}
