import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { execa } from 'execa'
import type { Forge, Unit } from '../core/types.js'
import { outputFile, WORK_DIR } from './workspace.js'

export type Outcome =
  | { kind: 'pr'; url: string; commits: number }
  | { kind: 'report'; text: string }
  | { kind: 'none'; reason: string; unpublished?: true }

const git = async (dir: string, ...args: string[]) =>
  (await execa('git', ['-C', dir, '-c', 'core.hooksPath=/dev/null', ...args])).stdout

/** Delivers a finished unit: a draft PR only with commits, a PR body and a branch new to the remote. */
export async function publish(
  unit: Unit,
  dir: string,
  forge: Forge,
  runId: string,
): Promise<Outcome> {
  const file = join(dir, WORK_DIR, 'out', outputFile[unit.deliver])
  const text = (await readFile(file, 'utf8').catch(() => '')).trim()
  if (unit.deliver === 'report')
    return text ? { kind: 'report', text } : { kind: 'none', reason: 'no report written' }

  const log = await git(dir, 'rev-list', 'HEAD', '--not', '--remotes')
  const commits = log.split('\n').filter(Boolean)
  const oldest = commits.at(-1)
  if (!oldest) return { kind: 'none', reason: 'no commits' }
  if (!text)
    return {
      kind: 'none',
      reason: `${commits.length} commits but no PR body, not pushed`,
      unpublished: true,
    }
  if (await forge.branchExists(unit.repo, unit.branch))
    return {
      kind: 'none',
      reason: `${unit.branch} already exists on ${unit.repo}, not pushed`,
      unpublished: true,
    }

  const trailer = `git commit -q --amend --no-edit --no-verify --trailer 'Night-shift: ${runId}'`
  await git(dir, 'rebase', '-q', '--exec', trailer, `${oldest}^`)
  await writeFile(
    join(dir, WORK_DIR, 'out', 'diff.patch'),
    `${await git(dir, 'diff', `${oldest}^`)}\n`,
  )
  await forge.push(dir, unit.branch, { repo: unit.repo })
  const url = await forge.draftPr(unit.repo, unit.branch, unit.base, file, runId)
  return { kind: 'pr', url, commits: commits.length }
}
