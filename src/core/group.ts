import type { ChildProcess } from 'node:child_process'

/**
 * Kills a child's process group (spawned with `killDescendants`) once the child exits or `stop`
 * aborts, so nothing it started outlives it unless it left the group. Returns a function that
 * stops listening to `stop`.
 */
export function killGroupWhenDone(
  child: { pid?: number; nodeChildProcess: ChildProcess },
  stop?: AbortSignal,
): () => void {
  const kill = () => {
    try {
      if (child.pid) process.kill(-child.pid, 'SIGKILL')
    } catch {}
  }
  child.nodeChildProcess.once('exit', kill)
  stop?.addEventListener('abort', kill, { once: true })
  if (stop?.aborted) kill()
  return () => stop?.removeEventListener('abort', kill)
}
