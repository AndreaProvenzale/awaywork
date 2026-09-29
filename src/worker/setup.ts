import { execa } from 'execa'

const TIMEOUT_MS = 15 * 60_000
const TAIL_LINES = 5

/** Runs the repo's setup command in the clone; returns why it failed with its output's tail, never throws. */
export async function runSetup(
  command: string,
  dir: string,
  env: NodeJS.ProcessEnv,
  log: (line: string) => void,
): Promise<string | undefined> {
  const result = await execa(command, {
    shell: true,
    cwd: dir,
    env,
    extendEnv: false,
    stdin: 'ignore',
    timeout: TIMEOUT_MS,
    reject: false,
    all: true,
  })
  const output = result.all?.trim() ?? ''
  if (output) log(`setup: ${output}`)
  if (!result.failed) return undefined
  const why = result.timedOut ? `timed out after ${TIMEOUT_MS / 60_000} min` : result.shortMessage
  const tail = output.split('\n').slice(-TAIL_LINES).join('\n')
  return [`setup failed: ${why}`, tail].filter(Boolean).join('\n')
}
