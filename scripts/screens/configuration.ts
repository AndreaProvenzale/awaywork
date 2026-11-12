import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  bitbucketChecks,
  type Check,
  checkLine,
  configFailure,
  dockerReady,
  folderLogin,
  ghLogin,
  imageClis,
  providerLogin,
  workerFailure,
} from '../../src/cli/doctor.js'
import { formatRun } from '../../src/cli/format/report.js'
import { formatQueue } from '../../src/cli/format/rules.js'
import { formatWhy } from '../../src/cli/format/why.js'
import { type Discoveries, formatDiscoveries } from '../../src/cli/sources.js'
import { loadConfig, parseConfig } from '../../src/config/load.js'
import { loginCommand, type Pin } from '../../src/config/logins.js'
import { planRun } from '../../src/core/foreman.js'
import { sudoersLines, WORKER } from '../../src/core/isolation.js'
import type { RunReport } from '../../src/core/report.js'
import { builtinSkills } from '../../src/core/skills.js'
import type { Item } from '../../src/core/types.js'
import type { Exec } from '../../src/forge/gh.js'
import { claude } from '../../src/providers/claude.js'
import { codex } from '../../src/providers/codex.js'
import {
  lastOccurrence,
  nextOccurrences,
  occurrenceKey,
  type Routine,
} from '../../src/sources/routines.js'

const item = (overrides: Partial<Item> & Pick<Item, 'source' | 'key' | 'url'>): Item => ({
  id: overrides.key,
  type: 'task',
  title: '',
  description: '',
  status: 'open',
  reviewers: [],
  labels: [],
  comments: [],
  linkedPrs: [],
  fields: {},
  mine: true,
  raw: null,
  ...overrides,
})

const plan = (yaml: string, items: Item[]) =>
  planRun({ config: parseConfig(yaml), items, allowances: {}, skills: { builtin: builtinSkills } })

const doctorLine = (c: Check) => checkLine(c, true)
const asCheck = ([status, what, detail]: [Check['status'], string, string]): Check => ({
  status,
  what,
  detail,
})

function sourcesLinear(): string {
  const discoveries: Discoveries = {
    found: [
      {
        id: 'linear',
        discovery: {
          teams: [
            {
              key: 'ENG',
              name: 'Engineering',
              states: ['Todo', 'In Progress', 'In Review', 'Done'],
            },
            { key: 'OPS', name: 'Operations', states: ['Todo', 'Done'] },
          ],
        },
      },
    ],
    failed: [],
  }
  // An excerpt: the first team's first two states.
  const lines = formatDiscoveries(discoveries).split('\n').slice(0, 7)
  return ['$ awaywork sources linear', ...lines, '    [...]'].join('\n')
}

async function bitbucketDoctor(): Promise<string> {
  const config = parseConfig(
    'providers: [claude]\nforge: bitbucket\nrepos: { acme/api: {} }\nsources: { jira: { site: acme.atlassian.net, email: me@acme.com } }',
  )
  const run: Exec = async (cmd, args) => {
    if (cmd === 'git')
      return args[0] === 'config' ? '' : '0000000000000000000000000000000000000000\tHEAD'
    if (args.includes('storage')) return '{ "data": { "authority": "file" } }'
    return '{}'
  }
  const version = { status: 'ok', what: 'twg', detail: '1.3.8' } as const
  return [version, ...(await bitbucketChecks(config, run))].map(doctorLine).join('\n')
}

async function extendsDoctor(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'awaywork-screens-'))
  const cwd = process.cwd()
  try {
    await mkdir(join(dir, 'team'))
    await mkdir(join(dir, 'roles'))
    await writeFile(
      join(dir, 'team/base.yml'),
      `windows: [{ start: "01:00", end: "7:00" }]
limits: { unit_minutes: 45 }
providers: [claude]
repos: { acme/api: {} }
sources: { github: {} }
instructions: [notes/team.md]`,
    )
    await writeFile(
      join(dir, 'roles/developer.yml'),
      `extends: ../team/base.yml
limits: { units: 6, units_per_repo: 3 }
queue:
  - skill: fix
    source: github
    where: { type: pr, mine: true, checks: failing }`,
    )
    // The error names the base as the role's path reaches it, relative here as on the command line.
    process.chdir(dir)
    const path = 'roles/developer.yml'
    const failed = await loadConfig(path, { pin: false }).then(
      () => {
        throw new Error(`${path} loads`)
      },
      (e: Error) => e,
    )
    // An excerpt: the config's own check, without the binaries' before it.
    return [`$ awaywork doctor --config ${path}`, doctorLine(configFailure(failed, path))].join(
      '\n',
    )
  } finally {
    process.chdir(cwd)
    await rm(dir, { recursive: true, force: true })
  }
}

async function loginsDoctor(): Promise<string> {
  const gh: Pin = { what: 'gh', key: 'forge.github.user', name: 'GH_TOKEN', value: 'gho_x' }
  const claudePin: Pin = {
    what: 'claude',
    key: 'providers[0].claude.config_dir',
    name: 'CLAUDE_CONFIG_DIR',
  }
  const codexDir = '~/.codex-work'
  // As src/config/logins.ts providerPins words a pinned folder that isn't there.
  const codexPin: Pin = {
    what: 'codex',
    key: 'providers[1].codex.config_dir',
    name: 'CODEX_HOME',
    problem: `${codexDir} doesn't exist; log in there with ${loginCommand(codex.loginDir as NonNullable<typeof codex.loginDir>, codexDir)}`,
  }
  return [
    ghLogin('octocat-acme', 'octocat-acme', gh, {}),
    folderLogin(claude, claudePin, '~/.claude-work', '<email>, max'),
    await providerLogin(codex, codexPin, {}),
  ]
    .map((c) => doctorLine(asCheck(c)))
    .join('\n')
}

function isolationUserDoctor(): string {
  const reason = `can't run as the ${WORKER} user (sudo: unknown user ${WORKER})`
  return doctorLine(workerFailure(reason, true, sudoersLines('runner', '1001:1001')))
}

function containerDoctor(): string {
  const found = ['claude 2.1.290 (Claude Code stand-in)', 'codex codex-cli 0.162.1 (stand-in)']
  // An excerpt: docker and the image, without the logins' warnings after them.
  return [dockerReady('27.4.0'), ...imageClis('acme/leak', 'awaywork-leak', found, [])]
    .map(doctorLine)
    .join('\n')
}

function routineWhy(): string {
  const now = new Date('2026-10-28T12:00:00Z')
  const routine: Routine = {
    days: ['mon'],
    at: ['09:00'],
    repo: 'acme/api',
    title: "Triage last week's Sentry issues",
    description: 'Group new issues, link duplicates, draft fixes for the top three.',
  }
  const at = lastOccurrence(routine, now)
  const key = occurrenceKey('sentry-triage', at)
  const routineItem = item({
    source: 'routines',
    key,
    title: routine.title,
    description: routine.description,
    url: 'https://github.com/acme/api',
    fields: {
      name: 'sentry-triage',
      repo: routine.repo,
      created: at.toISOString(),
      updated: at.toISOString(),
      state: 'open',
    },
  })
  const yaml = `providers: [claude]
repos: { acme/api: {} }
sources:
  routines:
    sentry-triage: { days: [mon], at: "09:00", repo: acme/api, title: Triage last week's Sentry issues }
queue:
  - { skill: triage, source: routines, where: { name: sentry-triage }, deliver: report, run: soon }`
  const planned = {
    ...plan(yaml, [routineItem]),
    routines: nextOccurrences({ 'sentry-triage': routine }, now),
  }
  // An excerpt: the item's heading, cut before its unit.
  const lines = formatWhy(planned, routineItem).split('\n').slice(0, 3)
  return [`$ awaywork plan --why ${key}`, ...lines, '  [...]'].join('\n')
}

function mergedRules(): string {
  const yaml = `providers: [claude]
repos: { acme/api: {} }
sources:
  github: {}
queue:
  - skill: review
    where: { type: pr, mine: true, state: merged, closed: { newer_than: 14d } }
    deliver: report`
  const { queue } = parseConfig(yaml)
  // Closed hours apart up to now, so the 14 days always hold the same 85.
  const prs = Array.from({ length: 85 }, (_, i) =>
    item({
      source: 'github',
      key: `acme/api#${329 - i}`,
      type: 'pr',
      url: `https://github.com/acme/api/pull/${329 - i}`,
      fields: {
        repo: 'acme/api',
        mine: true,
        state: 'merged',
        closed: new Date(Date.now() - i * 3_600_000).toISOString(),
      },
    }),
  )
  // Cut before the unmatched count, as the doc does.
  return ['$ awaywork plan --rules', ...formatQueue(queue ?? [], prs).slice(0, -1)].join('\n')
}

function onDoneReport(): string {
  const yaml = `providers: [claude]
repos: { acme/api: {} }
sources:
  jira: { site: acme.atlassian.net, email: dev@acme.com, repo_map: { ENG: acme/api } }
queue:
  - skill: implement
    source: jira
    where: { status: Ready }
    on_done: { comment: result, move: In Review }`
  const card = item({
    source: 'jira',
    key: 'ENG-12',
    title: 'Rate limit the public API',
    url: 'https://acme.atlassian.net/browse/ENG-12',
    fields: { status: 'Ready', repo: 'acme/api' },
  })
  const planned = plan(yaml, [card])
  const [unit] = planned.units
  if (!unit) throw new Error(`ENG-12 isn't planned: ${planned.skipped[0]?.reason}`)
  const report: RunReport = {
    runId: '20261026-010000',
    dryRun: false,
    startedAt: new Date('2026-10-26T01:00:00Z'),
    finishedAt: new Date('2026-10-26T01:20:00Z'),
    plan: planned,
    quotas: {},
    results: [
      {
        planned: unit,
        provider: 'claude',
        status: 'done',
        turns: 7,
        outcome: {
          kind: 'pr',
          url: 'https://github.com/acme/api/pull/41',
          commits: 2,
          head: 'abc1234',
        },
        result: [{ item: 'jira:ENG-12', url: 'https://acme.atlassian.net/browse/ENG-12' }],
        moved: [{ item: 'jira:ENG-12', to: 'In Review' }],
      },
    ],
  }
  const lines = formatRun(report, [], true).split('\n')
  const row = lines.findIndex((line) => line.includes('ENG-12'))
  // An excerpt: the unit's row and its notes, without the table's header and the unit's title.
  return [lines[row], ...lines.slice(row + 2, row + 4)].join('\n')
}

export default {
  'config-sources-linear': sourcesLinear(),
  'config-doctor-bitbucket': await bitbucketDoctor(),
  'config-doctor-extends': await extendsDoctor(),
  'config-doctor-logins': await loginsDoctor(),
  'config-doctor-isolation-user': isolationUserDoctor(),
  'config-doctor-container': containerDoctor(),
  'config-plan-why-routine': routineWhy(),
  'config-plan-rules-merged': mergedRules(),
  'config-report-on-done': onDoneReport(),
}
