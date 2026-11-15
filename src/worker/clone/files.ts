import { type CopyOptions, constants } from 'node:fs'
import { chmod, cp, type FileHandle, lstat, open, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import type { Deliver } from '#core/types'

/** Context, output and prompt live here inside the clone; git ignores it. */
export const WORK_DIR = '.away'
export const outputFile: Record<Deliver, string> = {
  draft_pr: 'pr.md',
  pr: 'pr.md',
  report: 'report.md',
  push: 'pr.md',
  pending_review: 'report.md',
  plan: 'report.md',
}

/** Whether a unit only reports: a `pending_review` one's report is left as a review, a `plan` one's posted with its plan. */
export const reportsOnly = (deliver: Deliver) =>
  deliver === 'report' || deliver === 'pending_review' || deliver === 'plan'

/** Throws when a symlink, which a worker may have planted, sits anywhere on one of `paths` in the clone. */
export async function refuseSymlinks(dir: string, paths: string[]): Promise<void> {
  for (const path of paths) {
    const parts = path.split('/')
    for (let i = 1; i <= parts.length; i++) {
      const part = parts.slice(0, i).join('/')
      if ((await lstat(join(dir, part)).catch(() => undefined))?.isSymbolicLink())
        throw new Error(`${part} in the clone is a symlink`)
    }
  }
}

/** Opens a file in the clone without following a symlink or blocking on a FIFO a worker planted, and refuses anything but a regular file with one link. */
async function openRegular(path: string, flags: number): Promise<FileHandle> {
  const file = await open(path, flags | constants.O_NONBLOCK | constants.O_NOFOLLOW)
  const stat = await file.stat()
  if (stat.isFile() && stat.nlink === 1) return file
  await file.close()
  throw new Error(`${path} isn't a regular file with a single link`)
}

/** A file a worker wrote, or '' when it's missing or isn't a regular file. */
export async function readOutput(path: string): Promise<string> {
  const file = await openRegular(path, constants.O_RDONLY).catch(() => undefined)
  if (!file) return ''
  try {
    return await file.readFile('utf8')
  } finally {
    await file.close()
  }
}

/** Writes, or with `append` appends, `text` to a file in the clone, refusing anything but a regular file. */
export async function writeOutput(path: string, text: string, append = false): Promise<void> {
  const file = await openRegular(
    path,
    constants.O_WRONLY | constants.O_CREAT | (append ? constants.O_APPEND : 0),
  )
  try {
    if (!append) await file.truncate()
    await file.writeFile(text)
  } finally {
    await file.close()
  }
}

/** A `cp` filter that leaves symlinks behind, so nothing later writes through one. */
export const notSymlink = async (src: string) => !(await lstat(src)).isSymbolicLink()

/**
 * Copies what repo code left in the clone out of it, without a symlink, nor the setuid or setgid bit
 * a container can set on a file it writes as you, which would otherwise sit in your run dir.
 */
export async function copyOut(src: string, dest: string, options: CopyOptions = {}): Promise<void> {
  try {
    await cp(src, dest, { recursive: true, filter: notSymlink, ...options })
  } finally {
    for (const path of await readdir(dest, { recursive: true }).catch(() => [])) {
      const stats = await lstat(join(dest, path))
      if (!stats.isSymbolicLink() && stats.mode & 0o6000)
        await chmod(join(dest, path), stats.mode & 0o1777)
    }
  }
}
