import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, rename, rm } from 'node:fs/promises'
import { dirname } from 'node:path'
import { type Exec, exec } from './gh.js'

/** A run a control repo's workflow uploaded as the artifact `<workflow>-<run id>`. */
export interface UploadedRun {
  id: string
  workflow: string
  repo: string
  artifact: string
  /** The Actions run that uploaded it. */
  actionsRun: string
}

/** The unexpired runs the named workflow uploaded to the repo in the current directory. */
export async function uploadedRuns(name: string, run: Exec = exec): Promise<UploadedRun[]> {
  const repo = (
    await run('gh', ['repo', 'view', '--json', 'nameWithOwner', '--jq', '.nameWithOwner'])
  ).trim()
  const out = await run('gh', [
    'api',
    '--paginate',
    `repos/${repo}/actions/artifacts?per_page=100`,
    '--jq',
    '.artifacts[] | select(.expired | not) | [.name, .workflow_run.id] | @tsv',
  ])
  return out.split('\n').flatMap((line) => {
    const [artifact = '', actionsRun = ''] = line.split('\t')
    const [, workflow = '', id = ''] = /^(.+)-(\d{8}-\d{6})$/.exec(artifact) ?? []
    return workflow === name ? [{ id, workflow, repo, artifact, actionsRun }] : []
  })
}

/** Downloads a run's files into `dir` unless they are there already; an artifact never changes. */
export async function fetchRun(r: UploadedRun, dir: string, run: Exec = exec): Promise<void> {
  if (existsSync(dir)) return
  await mkdir(dirname(dir), { recursive: true })
  const tmp = await mkdtemp(`${dir}-`)
  try {
    await run('gh', ['run', 'download', r.actionsRun, '-R', r.repo, '-n', r.artifact, '-D', tmp])
    await rename(tmp, dir)
  } finally {
    await rm(tmp, { recursive: true, force: true })
  }
}
