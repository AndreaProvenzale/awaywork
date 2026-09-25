import { Command } from 'commander'
import { configCommand } from './config.js'
import { planCommand } from './plan.js'

const program = new Command('nightshift')
  .description('Spend idle coding-subscription quota overnight')
  .option(
    '-c, --config <path>',
    'config file (default: $NIGHT_SHIFT_CONFIG or ~/.config/night-shift/config.yml)',
  )

configCommand(program)
planCommand(program)

await program.parseAsync()
