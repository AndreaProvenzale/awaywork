import { existsSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { clock } from '../core/window.js'

export const WORKFLOW = '.github/workflows/night-shift.yml'
export const REPO_CONFIG = '.night-shift/config.yml'

export interface Workflow {
  start: string
  /** IANA name; the schedule and the run's night window both use it. */
  timezone: string
  /** Repo path of the config the run reads. */
  config: string
  packages: string[]
  secrets: string[]
}

/** Preinstalled SDKs the runner doesn't need, about 20 GB (lessons.md, "Runners die quietly"). */
const unusedSdks = [
  '/usr/share/dotnet',
  '/usr/local/lib/android',
  '/opt/ghc',
  '/opt/hostedtoolcache/CodeQL',
]

/** A nightly workflow; secrets appear by name only, their values stay in the repo's settings. */
export function workflow(w: Workflow): string {
  const [hour, minute] = clock(w.start)
  const env = [
    `TZ: ${w.timezone}`,
    `NIGHT_SHIFT_CONFIG: ${w.config}`,
    ...w.secrets.map((name) => `${name}: \${{ secrets.${name} }}`),
  ]
  return `name: night-shift

on:
  schedule:
    - cron: "${minute} ${hour} * * *"
      timezone: ${w.timezone}
  workflow_dispatch:

concurrency: night-shift

jobs:
  night:
    runs-on: ubuntu-latest
    env:
${env.map((line) => `      ${line}`).join('\n')}
    steps:
      - name: Free disk
        run: sudo rm -rf ${unusedSdks.join(' ')}
      - uses: actions/checkout@v5
      - uses: actions/setup-node@v5
        with:
          node-version: 22
      - run: npm install -g ${['nightshift-agent', ...w.packages].join(' ')}
      - name: Commit as the token's user
        run: |
          user=$(gh api user --jq '"\\(.id)+\\(.login)"')
          git config --global user.name "\${user#*+}"
          git config --global user.email "$user@users.noreply.github.com"
      - run: nightshift run \${{ github.event_name == 'schedule' && '--scheduled' || '' }}
      - name: Morning report
        if: always()
        run: nightshift report >> "$GITHUB_STEP_SUMMARY" || true
`
}

/** Deletes the workflow under a repo root; false when there was none. */
export async function removeWorkflow(root: string): Promise<boolean> {
  const file = join(root, WORKFLOW)
  if (!existsSync(file)) return false
  await rm(file)
  return true
}
