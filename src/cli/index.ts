import { existsSync } from 'node:fs'
import { Command } from 'commander'
import { envFile, packageVersion } from '../config/paths.js'
import { approveCommand } from './approve.js'
import { configCommand } from './config.js'
import { doctorCommand } from './doctor.js'
import { initCommand } from './init.js'
import { planCommand } from './plan.js'
import { replayCommand } from './replay.js'
import { runCommand } from './run.js'
import { scheduleCommand } from './schedule.js'
import { skillsCommand } from './skills.js'
import { skipCommand } from './skip.js'
import { statsCommand } from './stats.js'

// The environment wins over the file; scheduled jobs start without a login shell's variables.
if (existsSync(envFile)) process.loadEnvFile(envFile)

// A reader that went away, as `| head` does, ends the command quietly, like git.
process.stdout.on('error', (e: NodeJS.ErrnoException) => {
  if (e.code !== 'EPIPE') throw e
  process.exit(0)
})

const program = new Command('awaywork')
  .description("Spend idle coding-subscription quota while you're away")
  .version(packageVersion)
  .option(
    '-c, --config <path>',
    'config file (default: $AWAYWORK_CONFIG or ~/.config/awaywork/config.yml)',
  )

initCommand(program)
configCommand(program)
planCommand(program)
skipCommand(program)
approveCommand(program)
skillsCommand(program)
runCommand(program)
statsCommand(program)
replayCommand(program)
scheduleCommand(program)
doctorCommand(program)

await program.parseAsync()
