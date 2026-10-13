import { existsSync } from 'node:fs'
import { readdir, readFile, rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { isMap, isNode, isScalar, parseDocument } from 'yaml'
import { skillsDirOf } from '../config/paths.js'
import type { Start } from './index.js'

export const WORKFLOW = '.github/workflows/awaywork.yml'
export const REPO_CONFIG = '.awaywork/config.yml'
export const REPO_SKILLS = skillsDirOf(REPO_CONFIG)
export const workflowOf = (person?: string) =>
  person ? `.github/workflows/awaywork-${person}.yml` : WORKFLOW
export const configOf = (person: string) => `.awaywork/${person}/config.yml`
/** A person's own secrets are `<NAME>__<PERSON>`, so no shared secret can stand in for one. */
export const suffixOf = (person: string) => `__${person.toUpperCase().replaceAll('-', '_')}`
const ACTION_REPO = 'AndreaProvenzale/awaywork'
const ACTION = `${ACTION_REPO}@v1`

export interface Workflow {
  starts: Start[]
  /** IANA name; the schedule and the run's windows both use it. */
  timezone: string
  /** Repo path of the config the run reads. */
  config: string
  /** The awaywork version the runner installs. */
  version: string
  packages: string[]
  secrets: string[]
  /** Command sources' setup scripts, run in the config's folder. */
  setup: string[]
  /** The job's `runs-on` as `runsOnOf` reads it, `ubuntu-latest` when unset. */
  runsOn?: string
  /** A person's workflow in a shared control repo. */
  person?: {
    name: string
    /** Their own secrets, read suffixed. */
    personal: string[]
    /** Whether their secrets are in their environment rather than the repo's. */
    environment: boolean
  }
}

/**
 * A scheduled workflow calling awaywork's action; secrets appear by name only, their values stay in the repo's settings.
 * Only the action's step gets them, and the job's GITHUB_TOKEN only reads: awaywork pushes with GH_TOKEN.
 */
export function workflow(w: Workflow): string {
  const person = w.person
  const from = (name: string) =>
    person?.personal.includes(name) ? name + suffixOf(person.name) : name
  const secrets = w.secrets.map((name) => `\n          ${name}: \${{ secrets.${from(name)} }}`)
  const setup = w.setup.map(
    (script) =>
      `      - working-directory: ${dirname(w.config)}\n        run: |\n${indent(script, 10)}\n`,
  )
  const name = person ? `awaywork-${person.name}` : 'awaywork'
  const runsOn = w.runsOn ?? 'ubuntu-latest'
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

permissions:
  contents: read

jobs:
  run:
    runs-on:${runsOn.startsWith('\n') ? '' : ' '}${runsOn}
${person?.environment ? `    environment: { name: ${JSON.stringify(person.name)}, deployment: false }\n` : ''}    env:
      TZ: ${w.timezone}
    steps:
      - uses: actions/checkout@v5
        with:
          persist-credentials: false
${setup.join('')}      - uses: ${ACTION}
${secrets.length ? `        env:${secrets.join('')}\n` : ''}        with:
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

/** The job's `runs-on` key and value nodes, positioned in the workflow's text. */
function runsOnPair(workflow: string) {
  const job = parseDocument(workflow).getIn(['jobs', 'run'], true)
  if (!isMap(job)) return
  const pair = job.items.find((p) => isScalar(p.key) && p.key.value === 'runs-on')
  return isScalar(pair?.key) && isNode(pair.value)
    ? { key: pair.key, value: pair.value }
    : undefined
}

/** The job's `runs-on` as written after the colon, e.g. `[self-hosted, macOS]`, or a block list from its newline. */
export function runsOnOf(workflow: string): string | undefined {
  const pair = runsOnPair(workflow)
  if (!pair?.key.range || !pair.value.range) return
  return workflow
    .slice(pair.key.range[2], pair.value.range[2])
    .replace(/^\s*:[ \t]*/, '')
    .trimEnd()
}

/** Whether a workflow's job runs on a self-hosted runner. */
export const isSelfHosted = (workflow: string) =>
  [runsOnPair(workflow)?.value.toJSON()].flat().includes('self-hosted')

/** Deletes the workflow, or a person's, under a repo root; false when there was none. */
export async function removeWorkflow(root: string, person?: string): Promise<boolean> {
  const file = join(root, workflowOf(person))
  if (!existsSync(file)) return false
  await rm(file)
  return true
}

/** The paths of every awaywork workflow under a repo root, people's included. */
export async function workflows(root: string): Promise<string[]> {
  const dir = join(root, dirname(WORKFLOW))
  const files = await readdir(dir).catch(() => [])
  return files
    .filter((f) => /^awaywork.*\.yml$/.test(f))
    .sort()
    .map((f) => join(dir, f))
}

/** Warns when the repo's workflow predates awaywork's action and runs its steps inline. */
export async function staleWorkflow(root: string): Promise<string | undefined> {
  const file = join(root, WORKFLOW)
  if (!existsSync(file) || (await readFile(file, 'utf8')).includes(`uses: ${ACTION_REPO}@`)) return
  return `${WORKFLOW} doesn't call awaywork's action; run \`awaywork schedule install --with github-actions\` again to update it`
}
