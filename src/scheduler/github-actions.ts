import { existsSync } from 'node:fs'
import { readFile, rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { isMap, isNode, isScalar, parseDocument } from 'yaml'
import { skillsDirOf } from '../config/paths.js'
import { HOSTED_JOB_MINUTES, SELF_HOSTED_JOB_MINUTES } from '../core/window.js'
import type { Start } from './index.js'

export const WORKFLOW = '.github/workflows/awaywork.yml'
export const REPO_CONFIG = '.awaywork/config.yml'
export const REPO_SKILLS = skillsDirOf(REPO_CONFIG)
const ACTION_REPO = 'AndreaProvenzale/awaywork'

export interface Workflow {
  /** Local to `timezone`; the cron gets them in UTC. */
  starts: Start[]
  /** IANA name the starts are in and the run's windows use. */
  timezone: string
  /** Repo path of the config the run reads. */
  config: string
  /** The awaywork version the runner installs; the action is pinned to its release tag. */
  version: string
  packages: string[]
  secrets: string[]
  /** Command sources' setup scripts, run in the config's folder. */
  setup: string[]
  /** The job's `runs-on` as `runsOnOf` reads it, `ubuntu-latest` when unset. */
  runsOn?: string
}

/**
 * A scheduled workflow calling awaywork's action; secrets appear by name only, their values stay in the repo's settings.
 * Only the action's step gets them, and the job's GITHUB_TOKEN only reads: awaywork pushes with GH_TOKEN.
 */
export function workflow(w: Workflow): string {
  const secrets = w.secrets.map((name) => `\n          ${name}: \${{ secrets.${name} }}`)
  const setup = w.setup.map(
    (script) =>
      `      - working-directory: ${dirname(w.config)}\n        run: |\n${indent(script, 10)}\n`,
  )
  const runsOn = w.runsOn ?? 'ubuntu-latest'
  const timeout = runsOn === 'ubuntu-latest' ? HOSTED_JOB_MINUTES : SELF_HOSTED_JOB_MINUTES
  return `name: awaywork

on:
  schedule:
${utcStarts(w.starts, w.timezone)
  .map((s) => `    - cron: "${s.minute} ${s.hour} * * ${s.days?.join(',') ?? '*'}"`)
  .join('\n')}
  workflow_dispatch:
    inputs:
      unit:
        description: Item key to run now, e.g. API-12; empty runs the plan
        default: ""

concurrency: awaywork

permissions:
  contents: read

jobs:
  run:
    runs-on:${runsOn.startsWith('\n') ? '' : ' '}${runsOn}
    timeout-minutes: ${timeout}
    env:
      TZ: ${w.timezone}
    steps:
      - uses: actions/checkout@v5
        with:
          persist-credentials: false
${setup.join('')}      - uses: ${ACTION_REPO}@v${w.version}
${secrets.length ? `        env:${secrets.join('')}\n` : ''}        with:
          config: ${w.config}
          version: ${w.version}
          packages: ${JSON.stringify(w.packages.join(' '))}
          unit: \${{ inputs.unit }}
`
}

/** Minutes east of UTC that `zone` is at `date`. */
function offsetAt(zone: string, date: Date): number {
  const name = new Intl.DateTimeFormat('en-US', { timeZone: zone, timeZoneName: 'longOffset' })
    .formatToParts(date)
    .find((p) => p.type === 'timeZoneName')?.value
  const [, sign, hours, minutes] = /GMT([+-])(\d\d):(\d\d)/.exec(name ?? '') ?? []
  return sign ? (sign === '-' ? -1 : 1) * (Number(hours) * 60 + Number(minutes)) : 0
}

/**
 * Starts in UTC, as GitHub ran our crons whatever their `timezone:` said.
 * The zone's smallest offset over the year gives the latest UTC time: never before the window opens, up to an hour late in summer time.
 */
function utcStarts(starts: Start[], zone: string): Start[] {
  const year = new Date().getUTCFullYear()
  const offset = Math.min(
    offsetAt(zone, new Date(Date.UTC(year, 0, 1))),
    offsetAt(zone, new Date(Date.UTC(year, 6, 1))),
  )
  return starts.map((s) => {
    const minutes = s.hour * 60 + s.minute - offset
    const shift = Math.floor(minutes / 1440)
    const utc = minutes - shift * 1440
    const days = s.days?.map((d) => (d + shift + 7) % 7).sort((a, b) => a - b)
    return { hour: Math.floor(utc / 60), minute: utc % 60, ...(days && { days }) }
  })
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

/** Whether a workflow's job runs on a self-hosted runner, by label, label list or `{ group, labels }`. */
export function isSelfHosted(workflow: string): boolean {
  const value = runsOnPair(workflow)?.value.toJSON()
  return [value?.labels ?? value].flat().includes('self-hosted')
}

/** Whether the job's `runs-on` is just `self-hosted`, which matches any self-hosted runner the repo can use. */
export const isPlainSelfHosted = (workflow: string) =>
  isDeepStrictEqual([runsOnPair(workflow)?.value.toJSON()].flat(), ['self-hosted'])

/** Deletes the workflow under a repo root; false when there was none. */
export async function removeWorkflow(root: string): Promise<boolean> {
  const file = join(root, WORKFLOW)
  if (!existsSync(file)) return false
  await rm(file)
  return true
}

/** Warns when the repo's workflow predates awaywork's action and runs its steps inline. */
export async function staleWorkflow(root: string): Promise<string | undefined> {
  const file = join(root, WORKFLOW)
  if (!existsSync(file) || (await readFile(file, 'utf8')).includes(`uses: ${ACTION_REPO}@`)) return
  return `${WORKFLOW} doesn't call awaywork's action; run \`awaywork schedule install --with github-actions\` again to update it`
}
