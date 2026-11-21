import { createWriteStream } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { contained, isolated } from '#core/isolation'
import { launch } from '#core/launch'
import type { Job, Rule, Unit } from '#core/types'
import { killGroupWhenDone } from '#util/process'
import { refuseSymlinks, WORK_DIR, writeOutput } from '#worker/clone/files'
import { killTree } from './watchdog'

const READY_MS = 5 * 60_000
const POLL_MS = 500
const TAIL_LINES = 20

/** What a step that asks for serve gets: the command to start and the URL to poll, or why neither. */
export interface ServeRequest {
  command?: string
  ready?: string
  logFile: string
  refused?: string
}

export interface Served {
  job: Job
  /** One line for the step's notes and the report. */
  note: string
  /** Kills serve and whatever it started. */
  stop(): Promise<void>
}

/** Whether the rule, or any of its steps, asks for serve. */
export const asksServe = (rule: Rule): boolean =>
  !!rule.serve ||
  (rule.then ?? []).some((s) => ('loop' in s ? s.loop : [s]).some((step) => step.serve))

/** The serve request of a step that asks: it runs where setup does, and only under `isolation: none` for now. */
export function serveRequest(
  unit: Unit,
  serve: { command: string; ready: string } | undefined,
  logFile: string,
): ServeRequest | undefined {
  if (!unit.rule.serve) return undefined
  const refused = !serve
    ? `${unit.repo} has no serve command`
    : unit.untrusted
      ? "this PR's author isn't trusted"
      : isolated() || contained()
        ? "isolation: user and container don't support it yet"
        : undefined
  return { ...serve, logFile, refused }
}

/** Starts the app for the agent and waits for it; the job it returns carries the prompt line and env for what came of it. */
export async function startServe(
  req: ServeRequest,
  job: Job,
  signal: AbortSignal,
  timeoutMs = READY_MS,
): Promise<Served> {
  const { command, ready, logFile, refused } = req
  if (refused || !command || !ready)
    return withLine(
      job,
      `Serve, not run: ${refused}. The app isn't running; don't start it yourself.`,
      `serve not run: ${refused}`,
    )
  const port = await freePort()
  const env = { ...job.env, AWAYWORK_PORT: String(port) }
  const url = ready.replaceAll(/\$\{?AWAYWORK_PORT\}?/g, String(port))
  const stopping = new AbortController()
  const child = launch(command, [], {
    shell: true,
    cwd: job.dir,
    env,
    extendEnv: false,
    stdin: 'ignore',
    killDescendants: true,
    reject: false,
    all: true,
    buffer: false,
    cancelSignal: stopping.signal,
  })
  child.all?.pipe(createWriteStream(logFile))
  killGroupWhenDone(child, stopping.signal)
  let exit: string | undefined
  const exited = child.then((r) => {
    exit = r.shortMessage ?? `exit ${r.exitCode}`
  })
  const stop = async () => {
    if (child.pid) await killTree(child.pid)
    stopping.abort()
    await exited
  }
  const failure = await waitReady(url, signal, timeoutMs, () => exit)
  if (failure) {
    await stop()
    const tail = (await readFile(logFile, 'utf8').catch(() => ''))
      .trimEnd()
      .split('\n')
      .slice(-TAIL_LINES)
      .map((line) => `    ${line}`)
      .join('\n')
    return withLine(
      job,
      `Serve didn't come up (\`${command}\`): ${failure}. The app isn't running; don't start it yourself.\n\n${tail}`,
      `serve didn't come up: ${failure}, see serve.log`,
    )
  }
  const origin = new URL(url).origin
  return withLine(
    { ...job, env: { ...env, AWAYWORK_SERVE_URL: origin } },
    `The app runs at ${origin}, started by awaywork from \`${command}\`; it stops with you. Don't start it again.`,
    `serve ready at ${origin}`,
    stop,
  )
}

/** The job with `line` added to its prompt, in the prompt file too, for a provider that reads that. */
async function withLine(
  job: Job,
  line: string,
  note: string,
  stop = async () => {},
): Promise<Served> {
  await refuseSymlinks(job.dir, [WORK_DIR])
  await writeOutput(join(job.dir, WORK_DIR, 'prompt.md'), `\n\n---\n\n${line}\n`, true)
  return { job: { ...job, prompt: `${job.prompt}\n\n---\n\n${line}\n` }, note, stop }
}

/** Why the app didn't come up, or undefined once the URL answers. */
async function waitReady(
  url: string,
  signal: AbortSignal,
  timeoutMs: number,
  exited: () => string | undefined,
): Promise<string | undefined> {
  const deadline = AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)])
  while (!deadline.aborted) {
    const code = exited()
    if (code) return `it exited before it was ready (${code})`
    if (await answers(url)) return undefined
    await sleep(POLL_MS, undefined, { signal: deadline }).catch(() => {})
  }
  return signal.aborted
    ? 'stopped before it was ready'
    : `not ready after ${timeoutMs / 60_000} min`
}

async function answers(url: string): Promise<boolean> {
  try {
    return (await fetch(url, { signal: AbortSignal.timeout(2000) })).status < 500
  } catch {
    return false
  }
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as { port: number }
      server.close(() => resolve(port))
    })
  })
}
