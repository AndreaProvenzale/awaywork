import { existsSync } from 'node:fs'
import { Command } from 'commander'
import { envFile } from '../config/paths.js'
import { configCommand } from './config.js'
import { doctorCommand } from './doctor.js'
import { initCommand } from './init.js'
import { planCommand } from './plan.js'
import { queueCommand } from './queue.js'
import { runCommand } from './run.js'
import { scheduleCommand } from './schedule.js'
import { skillsCommand } from './skills.js'

// The environment wins over the file; scheduled jobs start without a login shell's variables.
if (existsSync(envFile)) process.loadEnvFile(envFile)

const program = new Command('nightshift')
  .description('Spend idle coding-subscription quota overnight')
  .option(
    '-c, --config <path>',
    'config file (default: $NIGHT_SHIFT_CONFIG or ~/.config/night-shift/config.yml)',
  )

initCommand(program)
configCommand(program)
planCommand(program)
queueCommand(program)
skillsCommand(program)
runCommand(program)
scheduleCommand(program)
doctorCommand(program)

await program.parseAsync()
