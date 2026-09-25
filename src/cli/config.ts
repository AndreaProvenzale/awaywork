import type { Command } from 'commander'
import { z } from 'zod'
import { ConfigError, configPath, loadConfig } from '../config/load.js'
import { configSchema } from '../config/schema.js'
import { unknownSkills } from '../config/skills.js'

export function configCommand(program: Command): void {
  const config = program.command('config').description('inspect and validate the config')

  config
    .command('schema')
    .description('print the config JSON Schema, for editor autocompletion')
    .action(() => {
      console.log(JSON.stringify(z.toJSONSchema(configSchema, { io: 'input' }), null, 2))
    })

  config
    .command('check')
    .description('validate the config file')
    .action(async () => {
      const path = configPath(program.opts().config)
      try {
        const problems = unknownSkills(await loadConfig(path))
        if (problems.length > 0) throw new ConfigError(path, problems)
        console.log(`${path}: ok`)
      } catch (e) {
        if (!(e instanceof ConfigError)) throw e
        console.error(e.message)
        process.exitCode = 1
      }
    })
}
