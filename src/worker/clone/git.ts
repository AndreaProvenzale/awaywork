import { execa } from 'execa'
import { bin } from '#config/paths'
import { inClone } from './workspace'

export const git = async (dir: string, ...args: string[]) =>
  (await execa(bin('git'), [...inClone(dir), ...args])).stdout

export const head = (dir: string) => git(dir, 'rev-parse', 'HEAD')

export async function commitsSince(dir: string, start: string): Promise<number> {
  return Number(await git(dir, 'rev-list', '--count', `${start}..HEAD`))
}

/** `git status --porcelain` lines, one per uncommitted path; a nested repo's own config runs nothing. */
export async function uncommitted(dir: string): Promise<string[]> {
  const status = ['status', '--porcelain', '--ignore-submodules=dirty']
  return (await git(dir, ...status)).split('\n').filter(Boolean)
}

/** The paths matching `globs` the commits since `from` change, from `from` itself when `exact`, else from where it left HEAD's history; a rename counts as both of its paths. */
export async function changedPaths(dir: string, from: string, globs: string[], exact = false) {
  const paths = globs.map((glob) => `:(glob)${glob}`)
  const range = exact ? [from, 'HEAD'] : [`${from}...HEAD`]
  const diff = await git(dir, 'diff', '-z', '--name-only', '--no-renames', ...range, '--', ...paths)
  return diff.split('\0').filter(Boolean)
}
