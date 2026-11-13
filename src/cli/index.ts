import { existsSync } from 'node:fs'
import { Command } from 'commander'
import { envFile, packageVersion } from '../config/paths.js'
import { remoteCall } from '../run/remote.js'
import { approveCommand } from './commands/approve.js'
import { configCommand } from './commands/config.js'
import { doctorCommand } from './commands/doctor.js'
import { initCommand } from './commands/init.js'
import { planCommand } from './commands/plan.js'
import { replayCommand } from './commands/replay.js'
import { runCommand } from './commands/run.js'
import { scheduleCommand } from './commands/schedule.js'
import { secretCommand } from './commands/secret.js'
import { skillsCommand } from './commands/skills.js'
import { skipCommand } from './commands/skip.js'
import { sourcesCommand } from './commands/sources.js'
import { statsCommand } from './commands/stats.js'
import { watchCommand } from './commands/watch.js'

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
