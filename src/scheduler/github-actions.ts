import { existsSync } from 'node:fs'
import { readdir, readFile, rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { skillsDirOf } from '../config/paths.js'
import type { Start } from './index.js'

export const WORKFLOW = '.github/workflows/night-shift.yml'
export const REPO_CONFIG = '.night-shift/config.yml'
export const REPO_SKILLS = skillsDirOf(REPO_CONFIG)
export const workflowOf = (person?: string) =>
  person ? `.github/workflows/night-shift-${person}.yml` : WORKFLOW
export const configOf = (person: string) => `.night-shift/${person}/config.yml`
/** A person's own secrets are `<NAME>__<PERSON>`, so no shared secret can stand in for one. */
export const suffixOf = (person: string) => `__${person.toUpperCase().replaceAll('-', '_')}`
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
  /** A person's workflow in a shared control repo. */
  person?: {
    name: string
    /** Their own secrets, read suffixed. */
    personal: string[]
    /** Whether their secrets are in their environment rather than the repo's. */
    environment: boolean
  }
}

/** A nightly workflow calling night-shift's action; secrets appear by name only, their values stay in the repo's settings. */
export function workflow(w: Workflow): string {
  const person = w.person
  const from = (name: string) =>
    person?.personal.includes(name) ? name + suffixOf(person.name) : name
  const env = [
    `TZ: ${w.timezone}`,
    ...w.secrets.map((name) => `${name}: \${{ secrets.${from(name)} }}`),
  ]
  const setup = w.setup.map(
    (script) =>
      `      - working-directory: ${dirname(w.config)}\n        run: |\n${indent(script, 10)}\n`,
  )
  const name = person ? `night-shift-${person.name}` : 'night-shift'
  return `name: ${name}

on:
  schedule:
${w.starts
  .map(
    (s) =>
      `    - cron: "${s.minute} ${s.hour} * * ${s.days?.join(',') ?? '*'}"\n      timezone: ${w.timezone}`,
  )
  .join('\n')}
  workflow_dispatch:

concurrency: ${name}

jobs:
  night:
    runs-on: ubuntu-latest
${person?.environment ? `    environment: { name: ${JSON.stringify(person.name)}, deployment: false }\n` : ''}    env:
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

/** Deletes the workflow, or a person's, under a repo root; false when there was none. */
export async function removeWorkflow(root: string, person?: string): Promise<boolean> {
  const file = join(root, workflowOf(person))
  if (!existsSync(file)) return false
  await rm(file)
  return true
}

/** The paths of every night-shift workflow under a repo root, people's included. */
export async function workflows(root: string): Promise<string[]> {
  const dir = join(root, dirname(WORKFLOW))
  const files = await readdir(dir).catch(() => [])
  return files
    .filter((f) => /^night-shift.*\.yml$/.test(f))
    .sort()
    .map((f) => join(dir, f))
}

/** Warns when the repo's workflow predates night-shift's action and runs its steps inline. */
export async function staleWorkflow(root: string): Promise<string | undefined> {
  const file = join(root, WORKFLOW)
  if (!existsSync(file) || (await readFile(file, 'utf8')).includes(`uses: ${ACTION_REPO}@`)) return
  return `${WORKFLOW} doesn't call night-shift's action; run \`nightshift schedule install --with github-actions\` again to update it`
}
