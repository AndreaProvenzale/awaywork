import { existsSync } from 'node:fs'
import { Command } from 'commander'
import { envFile, packageVersion } from '#config/paths'
import { remoteCall } from '#run/remote'
import { approveCommand } from './commands/approve'
import { configCommand } from './commands/config'
import { doctorCommand } from './commands/doctor'
import { initCommand } from './commands/init'
import { planCommand } from './commands/plan'
import { replayCommand } from './commands/replay'
import { runCommand } from './commands/run'
import { scheduleCommand } from './commands/schedule'
import { secretCommand } from './commands/secret'
import { skillsCommand } from './commands/skills'
import { skipCommand } from './commands/skip'
import { sourcesCommand } from './commands/sources'
import { statsCommand } from './commands/stats'
import { watchCommand } from './commands/watch'

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
  .description('Run your coding agents on your real tasks, under rules you set')
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

// The commands a remote daemon serves run there, refused or not; anything else, here.
const remotely = remoteCall(process.argv.slice(2), { url, token })
if (remotely) process.exitCode = await remotely
else await program.parseAsync()
