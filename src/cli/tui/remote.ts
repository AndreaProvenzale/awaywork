import { captured, type Output, type Remote, remoteFor, type Send } from '#run/remote'
import { type ItemCommands, interactive, openScreen } from './browse'
import { fromScreenJson } from './triage'

// The flags that print text, as they do here.
const plain = ['--json', '--rules', '--skipped', '--why', '--list', '--unit', '--screen']

/** `plan` or `report` at a terminal with a remote: browsed here on the view the remote builds, the keys acting there; undefined when it doesn't browse. */
export function browseRemotely(args: string[], remote: Remote): Promise<number> | undefined {
  const [command] = args
  if (command !== 'plan' && command !== 'report') return
  if (!interactive() || args.some((a) => plain.includes(a.split('=')[0] as string))) return
  const send = remoteFor(args, remote)
  if (send) return browse(args, send, remote.url as string)
}

async function browse(args: string[], send: Send, url: string): Promise<number> {
  const plan = args[0] === 'plan'
  const screen = openScreen(plan ? 'Planning the next run' : 'Loading the report')
  try {
    screen.progress({ name: `${plan ? 'planning' : 'reading'} on ${url}`, state: 'running' })
    const out = await captured(send, [...args, '--screen'])
    const fetched = out.code === 0 ? fromScreenJson(out.stdout, process.stdout.rows) : undefined
    if (fetched) {
      await screen.browse(
        fetched.state,
        remoteCommands((more) => captured(send, more), fetched.run),
      )
      return 0
    }
    screen.close()
    if (!out.stderr.includes(': refused --screen')) {
      process.stdout.write(out.stdout)
      process.stderr.write(out.stderr)
      return out.code
    }
    const code = await send(args)
    console.error(
      `AWAYWORK_REMOTE (${url}) runs an older awaywork, so this prints instead of browsing; update awaywork there and restart watch`,
    )
    return code
  } finally {
    screen.close()
  }
}

/** What the keys run on the remote: `call` runs a CLI call there, `run` is the report's, whose units `l` and `d` name. */
function remoteCommands(call: (args: string[]) => Promise<Output>, run = ''): ItemCommands {
  const text = async (args: string[]) => {
    const { stdout, stderr, code } = await call(args)
    if (code) throw new Error(stderr.trim().split('\n').at(-1) || `exit ${code}`)
    return stdout
  }
  return {
    skip: async (key) => (await text(['skip', key])).trim(),
    approve: async (key) => (await text(['approve', key])).trim(),
    log: (unit) => text(['report', run, '--unit', unit, '--log']),
    diff: (unit) => text(['report', run, '--unit', unit, '--diff']),
  }
}
