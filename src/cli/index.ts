import { existsSync } from 'node:fs'
import { Command } from 'commander'
import { envFile, packageVersion } from '../config/paths.js'
import { approveCommand } from './approve.js'
import { configCommand } from './config.js'
import { doctorCommand } from './doctor.js'
import { initCommand } from './init.js'
import { planCommand } from './plan.js'
import { forward, servedRemotely } from './remote.js'
import { replayCommand } from './replay.js'
import { runCommand } from './run.js'
import { scheduleCommand } from './schedule.js'
import { secretCommand } from './secret.js'
import { skillsCommand } from './skills.js'
import { skipCommand } from './skip.js'
import { sourcesCommand } from './sources.js'
import { statsCommand } from './stats.js'
import { watchCommand } from './watch.js'

const shell = { ...process.env }
// The environment wins over the file; scheduled jobs start without a login shell's variables.
if (existsSync(envFile)) process.loadEnvFile(envFile)

const { AWAYWORK_REMOTE: url, AWAYWORK_REMOTE_TOKEN: token } = process.env
// Blank once read, so what this starts runs here and never sees the token: an empty variable wins over the file.
if (url !== undefined) process.env.AWAYWORK_REMOTE = ''
if (token !== undefined) process.env.AWAYWORK_REMOTE_TOKEN = ''

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
secretCommand(program, shell)
sourcesCommand(program)
planCommand(program)
skipCommand(program)
approveCommand(program)
skillsCommand(program)
runCommand(program)
watchCommand(program, { url, token })
statsCommand(program)
replayCommand(program)
scheduleCommand(program)
doctorCommand(program)

const args = process.argv.slice(2)
// The commands a remote daemon serves run there, refused or not; anything else, here.
if (url && token && servedRemotely(args)) process.exitCode = await forward(args, { url, token })
else await program.parseAsync()
