import { Command } from 'commander'
import { configCommand } from './config.js'

const program = new Command('nightshift')
  .description('Spend idle coding-subscription quota overnight')
  .option(
    '-c, --config <path>',
    'config file (default: $NIGHT_SHIFT_CONFIG or ~/.config/night-shift/config.yml)',
  )

configCommand(program)

await program.parseAsync()
