import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Exec } from './gh.js'

/** Git in the push repo runs no hooks and sees history as it is, not as replace refs say. */
const pushSafely = ['--no-replace-objects', '-c', 'core.hooksPath=/dev/null']

/**
 * Pushes `dir`'s HEAD to `remote` from a bare repo of its own, so `dir`'s config, hooks and refs steer
 * neither where the push goes nor what runs; `login` is git's args for the forge's credentials. With
 * `from`, only a descendant of it, while the branch is still at it; without, only while the branch
 * doesn't exist. The lease makes that a compare-and-swap but lifts git's own fast-forward check, so
 * the ancestry check here is what keeps history intact.
 */
export async function pushHead(
  run: Exec,
  login: string[],
  remote: string,
  dir: string,
  repo: string,
  branch: string,
  from?: string,
) {
  const bare = await mkdtemp(join(tmpdir(), 'awaywork-push-'))
  const git = (...args: string[]) => run('git', ['-C', bare, ...pushSafely, ...args])
  try {
    await run('git', ['init', '-q', '--bare', bare])
    await git('fetch', '-q', '--no-tags', dir, 'HEAD')
    // One commit, checked and pushed: nothing can move a ref in between.
    const head = (await git('rev-parse', '--verify', 'FETCH_HEAD^{commit}')).trim()
    if (
      from &&
      !(await git('merge-base', '--is-ancestor', from, head).then(
        () => true,
        () => false,
      ))
    )
      throw new Error(
        `refusing to push onto ${branch} on ${repo}: not a fast-forward from ${from.slice(0, 7)}`,
      )
    const lease = `--force-with-lease=refs/heads/${branch}:${from ?? ''}`
    await git(...login, 'push', lease, remote, `${head}:refs/heads/${branch}`)
  } finally {
    await rm(bare, { recursive: true, force: true })
  }
}
