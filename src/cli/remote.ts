import { createHash, timingSafeEqual } from 'node:crypto'
import { readdir } from 'node:fs/promises'
import { createServer, type IncomingMessage, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { createInterface } from 'node:readline'
import { Readable } from 'node:stream'
import type { ReadableStream } from 'node:stream/web'
import { execa } from 'execa'
import { envFile, runsDir } from '../config/paths.js'
import { awaitGroup } from '../core/group.js'
import { inAwayworkImage } from '../core/launch.js'

/** The port `awaywork watch` serves the CLI on when AWAYWORK_REMOTE_TOKEN is set. */
export const REMOTE_PORT = 7480
const MIN_TOKEN = 32
const MAX_BODY = 16 * 1024
const MAX_COMMANDS = 2
const TIMEOUT_MS = 2 * 60_000
const BEAT_MS = 30_000
const HOLD_MS = 500

/** A command's output, as the remote ran it; streamed as NDJSON lines, `code` last. */
export interface Output {
  stdout: string
  stderr: string
  code: number
}

/** A flag's value: always taken, taken when the next argument isn't a flag (as commander does), or none. */
type Value = 'required' | 'optional' | 'none'

/** The commands the remote runs, each with every flag it takes and how many positional arguments at most. */
const allowed: Record<string, { flags: Record<string, Value>; args: number }> = {
  report: {
    flags: { '--list': 'none', '--json': 'none', '--unit': 'required', '--skipped': 'optional' },
    args: 1,
  },
  plan: {
    flags: {
      '--json': 'none',
      '--repo': 'required',
      '--rule': 'required',
      '--rules': 'none',
      '--skipped': 'optional',
      '--why': 'required',
    },
    args: 0,
  },
  stats: { flags: { '--json': 'none' }, args: 0 },
  sources: { flags: { '--json': 'none' }, args: 1 },
  doctor: { flags: { '--json': 'none' }, args: 0 },
  'schedule status': { flags: {}, args: 0 },
  'config path': { flags: {}, args: 0 },
  skip: { flags: { '--until': 'required', '--reason': 'required' }, args: 1 },
  unskip: { flags: {}, args: 1 },
  approve: { flags: {}, args: Number.POSITIVE_INFINITY },
  run: { flags: { '--unit': 'required', '--detach': 'none' }, args: 0 },
}

export type Checked =
  | { command: string; args: string[]; options: Record<string, string | true> }
  | { refused: string }

// commander reads the global `-c` wherever it is, a flag's value included.
const isFlag = (arg: string) => arg.length > 1 && arg.startsWith('-')

/** The command, positional arguments and options of a CLI call the remote runs, or the argument it refuses. */
export function checkArgs(argv: unknown): Checked {
  if (!Array.isArray(argv) || !argv.every((a) => typeof a === 'string'))
    return { refused: 'args, which must be an array of strings' }
  const command = commandOf(argv)
  const spec = Object.hasOwn(allowed, command) ? allowed[command] : undefined
  if (!spec) return { refused: command || 'no command' }
  const rest = argv.slice(command.split(' ').length)
  const args: string[] = []
  const options: Record<string, string | true> = {}
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i] as string
    if (!isFlag(arg)) {
      args.push(arg)
      continue
    }
    const eq = arg.indexOf('=')
    const flag = eq > 0 ? arg.slice(0, eq) : arg
    const takes = Object.hasOwn(spec.flags, flag) ? spec.flags[flag] : undefined
    if (!takes || (takes === 'none' && eq > 0)) return { refused: arg }
    const next = rest[i + 1]
    if (eq > 0) options[flag] = arg.slice(eq + 1)
    else if (takes === 'none' || next === undefined) options[flag] = true
    else if (isFlag(next)) {
      if (takes === 'required') return { refused: `${arg} ${next}: write it ${flag}=${next}` }
      options[flag] = true
    } else options[flag] = rest[++i] as string
  }
  if (args.length > spec.args) return { refused: args[spec.args] as string }
  if (command === 'run' && typeof options['--unit'] !== 'string')
    return { refused: 'run without --unit <key>' }
  return { command, args, options }
}

const commandOf = (argv: string[]) =>
  argv[0] === 'schedule' || argv[0] === 'config' ? `${argv[0]} ${argv[1] ?? ''}` : (argv[0] ?? '')

const namesConfig = (arg: string) => /^(-c|--config(=|$))/.test(arg)

/** Whether a CLI call goes to the remote, which refuses what it doesn't take: all but help, a call naming a config here and the commands it doesn't serve. */
export function servedRemotely(argv: string[]): boolean {
  if (argv.some(namesConfig)) return false
  const checked = checkArgs(argv)
  if (!('refused' in checked)) return true
  const command = commandOf(argv)
  if (!Object.hasOwn(allowed, command) || ['-h', '--help'].includes(checked.refused)) return false
  return command !== 'run' || argv.some((a) => a === '--unit' || a.startsWith('--unit='))
}

/** AWAYWORK_REMOTE and AWAYWORK_REMOTE_TOKEN, as the CLI started with them. */
export interface Remote {
  url?: string
  token?: string
}

const fail = (line: string) => {
  console.error(line)
  return 1
}

/** Runs a CLI call where AWAYWORK_REMOTE says, its exit code; undefined when it runs here. */
export function remoteCall(args: string[], { url, token }: Remote): Promise<number> | undefined {
  if (args[0] === FROM_SSH) return fromSsh(args[1], url, token)
  if (!url || !servedRemotely(args)) return
  if (/^ssh:\/\//i.test(url)) return overSsh(args, url)
  if (!/^https?:\/\//i.test(url))
    return Promise.resolve(fail(`AWAYWORK_REMOTE (${url}) is neither ssh:// nor http(s)://`))
  if (token) return forward(args, { url, token })
}

// A flag, so a box on an older awaywork fails on it rather than running something else.
const FROM_SSH = '--from-ssh'

/** The argv for `ssh` to run a CLI call with the box's awaywork, which forwards it to its own daemon. */
export function sshArgs(url: string, args: string[]): string[] | undefined {
  const target = URL.canParse(url) ? new URL(url) : undefined
  if (!target?.hostname) return
  const { username, hostname, port } = target
  // base64url holds nothing any login shell reads, so the call needs no quoting.
  const call = Buffer.from(JSON.stringify([url, ...args])).toString('base64url')
  return [
    '-T',
    '-o',
    'BatchMode=yes',
    ...(port ? ['-p', port] : []),
    '--',
    username ? `${username}@${hostname}` : hostname,
    `env AWAYWORK_REMOTE=http://127.0.0.1:${REMOTE_PORT} awaywork ${FROM_SSH} ${call}`,
  ]
}

/** Runs a CLI call on the box an ssh:// AWAYWORK_REMOTE names, printing its output as it comes; its exit code. */
async function overSsh(args: string[], url: string): Promise<number> {
  const at = `AWAYWORK_REMOTE (${url})`
  const argv = sshArgs(url, args)
  if (!argv) return fail(`${at} names no host`)
  // Refused here as the box's daemon would: a much bigger call wouldn't fit in one argument there.
  if (Buffer.byteLength(JSON.stringify({ args })) > MAX_BODY)
    return fail(`${at}: the body is over ${MAX_BODY} bytes`)
  // A stdin nothing writes to: it closes when this process goes, and the box's end leaves with it.
  const ssh = execa('ssh', argv, { stdin: 'pipe', reject: false, buffer: false })
  // Held until stdout comes or HOLD_MS pass, so ssh's last lines, however split, can become this one's.
  let held = ''
  let hold: NodeJS.Timeout | undefined
  const flush = () => {
    clearTimeout(hold)
    hold = undefined
    process.stderr.write(held)
    held = ''
  }
  ssh.stdout.setEncoding('utf8').on('data', (text: string) => {
    flush()
    process.stdout.write(text)
  })
  ssh.stderr.setEncoding('utf8').on('data', (text: string) => {
    held += text
    hold ??= setTimeout(flush, HOLD_MS)
  })
  const { exitCode, originalMessage } = await ssh
  clearTimeout(hold)
  if (exitCode === 255)
    return fail(`can't reach ${at}: ${held.trim().split('\n').at(-1)?.trim() || 'ssh exited 255'}`)
  if (exitCode === 127)
    return fail(
      `${at}: awaywork isn't on the box's PATH for non-interactive ssh; install it and node system-wide there, or link both into /usr/local/bin`,
    )
  flush()
  return exitCode ?? fail(`can't reach ${at}: ${originalMessage}`)
}

/** On the box, a call that came over ssh, `[via, ...args]` as base64url JSON: forwarded to this box's daemon until the laptop's end goes. */
async function fromSsh(word = '', url = '', token = ''): Promise<number> {
  let call: unknown
  try {
    call = JSON.parse(Buffer.from(word, 'base64url').toString())
  } catch {}
  if (!Array.isArray(call) || !call.length || !call.every((a) => typeof a === 'string'))
    return fail(`awaywork ${FROM_SSH}: not a call as awaywork sends it over ssh`)
  const [via, ...args] = call as string[]
  if (!token)
    return fail(
      `AWAYWORK_REMOTE (${via}): the box's daemon isn't serving, the box's ${envFile} has no AWAYWORK_REMOTE_TOKEN; add one there and restart awaywork watch`,
    )
  // ssh passes no Ctrl-C without a terminal, but the laptop's end going closes stdin.
  process.stdin.once('end', () => process.exit(130)).resume()
  const code = await forward(args, { url, token }, via)
  process.stdin.destroy()
  return code
}

/** Runs a CLI call on the remote, printing its output as it comes; its exit code. */
export async function forward(
  args: string[],
  remote: { url: string; token: string },
  via?: string,
): Promise<number> {
  const at = `AWAYWORK_REMOTE (${via ?? remote.url})`
  let res: Response
  try {
    res = await fetch(`${remote.url.replace(/\/+$/, '')}/cli`, {
      method: 'POST',
      headers: { authorization: `Bearer ${remote.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ args }),
      signal: AbortSignal.timeout(TIMEOUT_MS + 30_000),
    })
  } catch (e) {
    const { cause, message } = e as Error & { cause?: Error }
    const reason = cause?.message ?? message
    return fail(
      via
        ? `${at}: the box's daemon isn't serving (${reason}); is awaywork watch running there, with AWAYWORK_REMOTE_TOKEN in its env file?`
        : `can't reach ${at}: ${reason}`,
    )
  }
  if (res.status === 401)
    return fail(
      via
        ? `${at}: the box's daemon runs with another AWAYWORK_REMOTE_TOKEN than its env file; restart awaywork watch there`
        : `${at} refused AWAYWORK_REMOTE_TOKEN`,
    )
  const unlike = `answered HTTP ${res.status}, not as awaywork watch does`
  if (!res.ok || !res.body) {
    const body: { error?: string } = await res.json().catch(() => ({}))
    console.error(`${at}: ${body.error ?? unlike}`)
    return 1
  }
  try {
    for await (const line of createInterface({
      input: Readable.fromWeb(res.body as ReadableStream),
    })) {
      const { stdout, stderr, code }: Partial<Output> = JSON.parse(line) ?? {}
      if (stdout) process.stdout.write(stdout)
      if (stderr) process.stderr.write(stderr)
      if (typeof code === 'number') return code
    }
    console.error(`${at}: ${unlike}`)
  } catch (e) {
    const { cause, message } = e as Error & { cause?: Error }
    if (e instanceof SyntaxError) console.error(`${at}: ${unlike}`)
    else console.error(`${at} stopped answering: ${cause?.message ?? message}`)
  }
  return 1
}

export interface Serve {
  /** The daemon's config, the only one the commands run with. */
  config: string
  log: (line: string) => void
  /** Queues a one-off run of the item, as `run --unit` asks. */
  runUnit: (key: string) => Promise<Output>
  /** The CLI to spawn, `awaywork` itself by default. */
  cli?: string[]
  port?: number
  timeout?: number
  /** How often a command printing nothing sends a line anyway, so proxies keep the request open. */
  beat?: number
}

/**
 * Serves `POST /cli` when `remote` has a token and no URL of its own to forward to: the allowlisted
 * commands, run with the daemon's config and env; undefined when it opens no port.
 */
export function serveRemote(remote: Remote, s: Serve): Server | undefined {
  const { token } = remote
  if (!token) return
  if (remote.url) {
    s.log('remote: AWAYWORK_REMOTE is set, so this machine forwards to it and opens no port')
    return
  }
  if (token.length < MIN_TOKEN) {
    s.log(
      `remote: AWAYWORK_REMOTE_TOKEN is shorter than ${MIN_TOKEN} characters, so no port is open; openssl rand -hex 32 makes one`,
    )
    return
  }
  const wanted = digest(`Bearer ${token}`)
  let running = 0
  const server = createServer(async (req, res) => {
    const send = (status: number, body: object, outcome?: string) => {
      res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body))
      if (outcome) s.log(`remote: ${outcome}`)
    }
    // Unlogged: scanners on a public domain would fill watch.log.
    if (req.method !== 'POST' || req.url !== '/cli') return send(404, { error: 'not found' })
    if (!timingSafeEqual(digest(req.headers.authorization ?? ''), wanted))
      return send(401, { error: 'wrong token' }, '401, wrong token')
    if (running >= MAX_COMMANDS)
      return send(429, { error: `${MAX_COMMANDS} commands are running, try again` }, '429, busy')
    running++
    const left = new AbortController()
    res.on('close', () => left.abort())
    try {
      const body = await readBody(req)
      if (body === undefined)
        return send(413, { error: `the body is over ${MAX_BODY} bytes` }, '413, body too big')
      let args: unknown
      try {
        args = JSON.parse(body).args
      } catch {
        return send(400, { error: 'the body is not JSON' }, '400, not JSON')
      }
      const checked = checkArgs(args)
      const call = JSON.stringify(args)
      if ('refused' in checked)
        return send(
          403,
          { error: `refused ${checked.refused}` },
          `${call}: 403, ${checked.refused}`,
        )
      const id = checked.command === 'report' ? checked.args[0] : undefined
      if (id !== undefined && !(await readdir(runsDir).catch(() => [] as string[])).includes(id))
        return send(
          403,
          { error: `no run ${id}; awaywork report --list lists them` },
          `${call}: 403, no run ${id}`,
        )
      res.writeHead(200, { 'content-type': 'application/x-ndjson' }).flushHeaders()
      const write = (line: Partial<Output>) => res.write(`${JSON.stringify(line)}\n`)
      const beat = setInterval(() => write({}), s.beat ?? BEAT_MS)
      try {
        const code =
          checked.command === 'run'
            ? await s.runUnit(checked.options['--unit'] as string).then(({ code, ...out }) => {
                write(out)
                return code
              })
            : await runCli(
                s.cli ?? self(),
                ['--config', s.config, ...(args as string[])],
                write,
                left.signal,
                s.timeout,
              )
        res.end(`${JSON.stringify({ code })}\n`)
        // A run --unit queues all the same, so only a CLI call stops.
        const stopped = checked.command !== 'run' && left.signal.aborted
        s.log(`remote: ${call}: ${stopped ? 'stopped, the client left' : `exit ${code}`}`)
      } finally {
        clearInterval(beat)
      }
    } catch (e) {
      if (!res.headersSent) send(500, { error: String(e) }, `500, ${String(e)}`)
      else res.end(`${JSON.stringify({ stderr: `${String(e)}\n`, code: 1 })}\n`)
    } finally {
      running--
    }
  })
  server.on('error', (e) => s.log(`remote: no port open: ${e.message}`))
  // The image's proxy reaches it from another container; anywhere else, only a proxy on this machine.
  const host = inAwayworkImage(process.env) ? undefined : '127.0.0.1'
  server.listen(s.port ?? REMOTE_PORT, host, () => {
    const { port } = server.address() as AddressInfo
    s.log(`remote: serving the CLI on port ${port}${host ? `, ${host} only` : ''}`)
  })
  return server
}

const digest = (text: string) => createHash('sha256').update(text).digest()

/** The request's body, or undefined past MAX_BODY. */
async function readBody(req: IncomingMessage): Promise<string | undefined> {
  if (Number(req.headers['content-length']) > MAX_BODY) return undefined
  const chunks: Buffer[] = []
  let size = 0
  // Read to the end, so the response still reaches the client.
  for await (const chunk of req as AsyncIterable<Buffer>) {
    size += chunk.length
    if (size <= MAX_BODY) chunks.push(chunk)
  }
  return size > MAX_BODY ? undefined : Buffer.concat(chunks).toString()
}

/** This awaywork, as the daemon was started. */
const self = () => [process.execPath, ...process.execArgv, process.argv[1] as string]

/**
 * Runs `cli` with `args` as argv, no shell nor terminal, the remote's variables blank, writing its
 * output as it comes until it ends or `stop` aborts; its process group goes with it. Its exit code.
 */
async function runCli(
  [file, ...pre]: string[],
  args: string[],
  write: (line: Partial<Output>) => void,
  stop: AbortSignal,
  timeout = TIMEOUT_MS,
): Promise<number> {
  const child = execa(file as string, [...pre, ...args], {
    env: { ...process.env, AWAYWORK_REMOTE: '', AWAYWORK_REMOTE_TOKEN: '' },
    stdin: 'ignore',
    timeout,
    cancelSignal: stop,
    detached: true,
    reject: false,
    buffer: false,
  })
  for (const name of ['stdout', 'stderr'] as const)
    child[name].setEncoding('utf8').on('data', (text: string) => write({ [name]: text }))
  const ran = await awaitGroup(child)
  if (ran.timedOut) write({ stderr: `timed out after ${timeout / 60_000} minutes\n` })
  return ran.exitCode ?? 1
}
