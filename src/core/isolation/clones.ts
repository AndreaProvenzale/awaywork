/** Clones repo code ran in since awaywork last put their git config back: their `.git` may be the worker's. */
export const unrestored = new Set<string>()
/** Whether repo code ran in the clone `dir` after its git config was last put back. */
export const gitUnrestored = (dir: string) => unrestored.has(dir)
export const markGitRestored = (dir: string) => void unrestored.delete(dir)

/** Clones and their homes a chown failed on or the worker swapped: they may still be the worker's, so awaywork touches them no more. */
export const lost = new Set<string>()
/** Whether `path` is, or holds, a clone lost to the worker user. */
export const lostToWorker = (path: string) =>
  [...lost].some((dir) => dir === path || dir.startsWith(`${path}/`))

export function lose(dirs: string[], reason: string): never {
  for (const dir of dirs) lost.add(dir)
  throw new Error(reason)
}
