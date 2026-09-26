import { existsSync } from 'node:fs'
import { Command } from 'commander'
import { envFile } from '../config/paths.js'
import { ciCommand } from './ci.js'
import { configCommand } from './config.js'
import { doctorCommand } from './doctor.js'
import { planCommand } from './plan.js'
import { runCommand } from './run.js'
import { scheduleCommand } from './schedule.js'

// The environment wins over the file; scheduled jobs start without a login shell's variables.
if (existsSync(envFile)) process.loadEnvFile(envFile)

const program = new Command('nightshift')
  .description('Spend idle coding-subscription quota overnight')
  .option(
    '-c, --config <path>',
    'config file (default: $NIGHT_SHIFT_CONFIG or ~/.config/night-shift/config.yml)',
  )

configCommand(program)
planCommand(program)
runCommand(program)
scheduleCommand(program)
ciCommand(program)
doctorCommand(program)

await program.parseAsync()
