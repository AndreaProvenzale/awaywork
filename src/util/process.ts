import type { ChildProcess } from 'node:child_process'

/** The handles of the Claude Code session awaywork runs in: its messaging socket and IDE bridge, its identity and plugin dirs. */
const parentSession = [
  'CLAUDECODE',
  'CLAUDE_PID',
  'CLAUDE_EFFORT',
  'CLAUDE_CODE_MESSAGING_SOCKET',
  'CLAUDE_CODE_MESSAGING_TOKEN',
  'CLAUDE_CODE_SSE_PORT',
  'CLAUDE_CODE_SESSION_ID',
  'CLAUDE_CODE_BRIDGE_SESSION_ID',
  'CLAUDE_CODE_CHILD_SESSION',
  'CLAUDE_CODE_CHILD_NOTES_DIR',
  'CLAUDE_CODE_SESSION_ATTENDED',
  'CLAUDE_CODE_ENTRYPOINT',
  'CLAUDE_CODE_EXECPATH',
  'CLAUDE_CODE_PLUGIN_DIRS',
]

export const withoutParentSession = (env: NodeJS.ProcessEnv): NodeJS.ProcessEnv =>
  Object.fromEntries(Object.entries(env).filter(([name]) => !parentSession.includes(name)))

type Child = { pid?: number; nodeChildProcess: ChildProcess }

function killGroup(child: Child): void {
  try {
    if (child.pid) process.kill(-child.pid, 'SIGKILL')
  } catch {}
}

/**
 * Kills a child's process group (spawned with `killDescendants`) once the child exits or `stop`
 * aborts, so nothing it started outlives it unless it left the group. Returns a function that
 * stops listening to `stop`.
 */
export function killGroupWhenDone(child: Child, stop?: AbortSignal): () => void {
  const kill = () => killGroup(child)
  child.nodeChildProcess.once('exit', kill)
  stop?.addEventListener('abort', kill, { once: true })
  if (stop?.aborted) kill()
  return () => stop?.removeEventListener('abort', kill)
}

/** How long a CLI gets to exit once it has printed its result. */
const RESULT_GRACE_MS = 5000

/** Kills a child's group a grace after its result: a CLI doesn't exit while a server its shell started runs. */
export function killGroupSoon(child: Child): void {
  const { exitCode, signalCode } = child.nodeChildProcess
  if (exitCode !== null || signalCode !== null) return
  const timer = setTimeout(() => killGroup(child), RESULT_GRACE_MS)
  timer.unref()
  child.nodeChildProcess.once('exit', () => clearTimeout(timer))
}

/** Awaits a `detached` child, then kills its group; this process exiting first kills it too. */
export async function awaitGroup<T extends Child & PromiseLike<unknown>>(
  child: T,
): Promise<Awaited<T>> {
  const kill = () => killGroup(child)
  process.once('exit', kill)
  child.nodeChildProcess.once('exit', () => {
    process.off('exit', kill)
    kill()
  })
  try {
    return await child
  } finally {
    process.off('exit', kill)
  }
}
