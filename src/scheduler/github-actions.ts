import { existsSync } from 'node:fs'
import { readFile, rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { skillsDirOf } from '../config/paths.js'
import type { Start } from './index.js'

export const WORKFLOW = '.github/workflows/night-shift.yml'
export const REPO_CONFIG = '.night-shift/config.yml'
export const REPO_SKILLS = skillsDirOf(REPO_CONFIG)
const ACTION_REPO = 'AndreaProvenzale/night-shift'
const ACTION = `${ACTION_REPO}@v1`

export interface Workflow {
  starts: Start[]
  /** IANA name; the schedule and the run's night window both use it. */
  timezone: string
  /** Repo path of the config the run reads. */
  config: string
  /** The nightshift-agent version the runner installs. */
  version: string
  packages: string[]
  secrets: string[]
  /** Command sources' setup scripts, run in the config's folder. */
  setup: string[]
}

/** A nightly workflow calling night-shift's action; secrets appear by name only, their values stay in the repo's settings. */
export function workflow(w: Workflow): string {
  const env = [`TZ: ${w.timezone}`, ...w.secrets.map((name) => `${name}: \${{ secrets.${name} }}`)]
  const setup = w.setup.map(
    (script) =>
      `      - working-directory: ${dirname(w.config)}\n        run: |\n${indent(script, 10)}\n`,
  )
  return `name: night-shift

on:
  schedule:
${w.starts
  .map(
    (s) =>
      `    - cron: "${s.minute} ${s.hour} * * ${s.days?.join(',') ?? '*'}"\n      timezone: ${w.timezone}`,
  )
  .join('\n')}
  workflow_dispatch:

concurrency: night-shift

jobs:
  night:
    runs-on: ubuntu-latest
    env:
${env.map((line) => `      ${line}`).join('\n')}
    steps:
      - uses: actions/checkout@v5
${setup.join('')}      - uses: ${ACTION}
        with:
          config: ${w.config}
          version: ${w.version}
          packages: ${JSON.stringify(w.packages.join(' '))}
`
}

function indent(text: string, spaces: number): string {
  return text
    .trimEnd()
    .split('\n')
    .map((line) => ' '.repeat(spaces) + line)
    .join('\n')
}

/** Deletes the workflow under a repo root; false when there was none. */
export async function removeWorkflow(root: string): Promise<boolean> {
  const file = join(root, WORKFLOW)
  if (!existsSync(file)) return false
  await rm(file)
  return true
}

/** Warns when the repo's workflow predates night-shift's action and runs its steps inline. */
export async function staleWorkflow(root: string): Promise<string | undefined> {
  const file = join(root, WORKFLOW)
  if (!existsSync(file) || (await readFile(file, 'utf8')).includes(`uses: ${ACTION_REPO}@`)) return
  return `${WORKFLOW} doesn't call night-shift's action; run \`nightshift schedule install --with github-actions\` again to update it`
}
