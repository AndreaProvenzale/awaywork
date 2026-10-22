import type { ChildProcess } from 'node:child_process'

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

/** Awaits a `detached` child, then kills its group; awaywork exiting first kills it too. */
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
