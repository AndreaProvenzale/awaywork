import { existsSync, statSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import type { Command } from 'commander'
import { execa } from 'execa'
import { parse } from 'yaml'
import { configPath, loadConfig } from '../config/load.js'
import { bin, configDir, envFile, skillsDirIn, skillsDirOf } from '../config/paths.js'
import type { Config } from '../config/schema.js'
import { hasSkills, unknownSkillsWarning } from '../config/skills.js'
import { allowance } from '../core/budget.js'
import { sudoersLines, WORKER, workerFor } from '../core/launch.js'
import type { Ctx } from '../core/types.js'
import { type Exec, exec } from '../forge/gh.js'
import { providerFor } from '../providers/index.js'
import { staleWorkflow, WORKFLOW } from '../scheduler/github-actions.js'
import { isCommand } from '../sources/command.js'
import { sourceFor } from '../sources/index.js'
import { describeAllowance, type Status, statusMarker } from './format.js'
import { gitRoot, staleSchedules } from './schedule.js'

interface Check {
  status: Status
  what: string
  detail: string
}

export function doctorCommand(program: Command): void {
  program
    .command('doctor')
    .description(
      'validate the config and check binaries, credentials, quota and sources before a run',
    )
    .option('--json', 'print the checks as a JSON array of { status, what, detail }')
    .action(async (opts: { json?: boolean }) => {
      const color = Boolean(process.stdout.isTTY) && !process.env.NO_COLOR
      const checks = await runChecks(configPath(program.opts().config), (c) => {
        if (!opts.json)
          console.log(`${statusMarker(c.status, color)}  ${c.what}${c.detail && `: ${c.detail}`}`)
      })
      if (opts.json) console.log(JSON.stringify(checks, null, 2))
      if (checks.some((c) => c.status === 'FAIL')) process.exitCode = 1
    })
}

/** Runs every check in order, handing each to onCheck as soon as it is known. */
export async function runChecks(path: string, onCheck: (check: Check) => void): Promise<Check[]> {
  const checks: Check[] = []
  const report = (status: Status, what: string, detail = '') => {
    const check = { status, what, detail }
    checks.push(check)
    onCheck(check)
  }
  const ctx: Ctx = { env: process.env, log: (line) => report('warn', line) }
  const secret = (name: string) => (process.env[name] ? `${name} set` : `${name} unset`)

  for (const bin of ['git', 'gh']) {
    const version = await exec(bin, ['--version']).catch(() => undefined)
    report(version ? 'ok' : 'FAIL', bin, version?.split('\n')[0] ?? 'not found on PATH')
  }
  await exec('gh', ['auth', 'status']).then(
    () => report('ok', 'gh login'),
    () => report(process.env.GH_TOKEN ? 'ok' : 'FAIL', 'gh login', secret('GH_TOKEN')),
  )
  if (existsSync(envFile)) {
    const mode = statSync(envFile).mode & 0o777
    if (mode === 0o600) report('ok', envFile, 'mode 600')
    else report('warn', envFile, `mode ${mode.toString(8)}, want 600`)
  }
  const defaultSkills = skillsDirIn(configDir)
  if (dirname(resolve(path)) !== configDir && (await hasSkills(defaultSkills)))
    report(
      'warn',
      defaultSkills,
      `not used with this config; move or link its skills to ${skillsDirOf(path)}`,
    )

  let config: Config
  try {
    config = await loadConfig(path)
  } catch (e) {
    report('FAIL', path, (e as Error).message.split('\n').slice(1).join('; ').trim())
    return checks
  }
  const unknown = await unknownSkillsWarning(config, skillsDirOf(path))
  report(unknown ? 'warn' : 'ok', path, unknown)
  for (const warning of await staleSchedules(path, config.windows))
    report('warn', 'schedule', warning)
  const root = await gitRoot()
  const workflow = root && (await staleWorkflow(root))
  if (workflow) report('warn', 'schedule', workflow)
  for (const c of root ? await workflowSecretChecks(root) : []) report(c.status, c.what, c.detail)
  const isolation = await isolationChecks(config.isolation, process.env)
  for (const c of isolation) report(c.status, c.what, c.detail)
  const asWorker = isolation[0]?.status === 'ok'

  for (const { id, config: providerConfig, budget } of config.providers) {
    const provider = providerFor(id, providerConfig)
    if (!provider) continue
    const unavailable = provider.unavailable?.(process.env)
    if (unavailable) {
      report('warn', id, `unavailable: ${unavailable}`)
      continue
    }
    const found = await provider.detect().catch((e: Error) => e)
    if (found instanceof Error || !found.installed) {
      report('FAIL', id, found instanceof Error ? found.message : 'not installed')
      continue
    }
    const facts = [
      found.version,
      `unattended: ${provider.unattended}`,
      ...provider.secrets.map(secret),
    ]
    report(provider.unattended === 'allowed' ? 'ok' : 'warn', id, facts.filter(Boolean).join(', '))
    const unset = provider.secrets.filter((name) => !process.env[name])
    if (asWorker && !provider.login && unset.length > 0)
      report('warn', id, `the ${WORKER} user can't use your login: set ${unset.join(', ')}`)
    await provider.probe(ctx).then(
      (quota) => {
        const a = allowance(budget, quota, Date.now(), config.windows)
        report(a.kind === 'quota' ? 'ok' : 'warn', `${id} quota`, describeAllowance(id, a))
      },
      (e: Error) => report('FAIL', `${id} probe`, e.message),
    )
  }

  for (const [id, cfg] of Object.entries(config.sources)) {
    const source = sourceFor(id, cfg)
    if (!source) continue
    const secrets = source.secrets(cfg).map(secret)
    await source.items(cfg, ctx).then(
      (items) => report('ok', id, [`${items.length} open items`, ...secrets].join(', ')),
      (e: Error) => report('FAIL', id, [e.message, ...secrets].join(', ')),
    )
    if (isCommand(cfg) && /(^|\s)(~|\$HOME)\//.test(cfg.command))
      report('warn', id, 'the command reads your home folder, which GitHub Actions lacks')
  }
  for (const [name, server] of Object.entries(config.mcp)) {
    const unset = server.secrets.filter((s) => !process.env[s])
    const facts = [server.command ?? server.url, ...server.secrets.map(secret)].join(', ')
    report(unset.length > 0 ? 'warn' : 'ok', `mcp ${name}`, facts)
  }
  return checks
}

const SAFETY = 'https://andreaprovenzale.github.io/awaywork/guide/safety#not-a-sandbox'

/** Who repo code runs as, and on local Linux what `isolation: user` still needs from you. */
export async function isolationChecks(
  isolation: Config['isolation'],
  env: NodeJS.ProcessEnv,
): Promise<Check[]> {
  const worker = await workerFor(isolation, env).catch((e: Error) => e)
  if (worker === undefined)
    return [
      {
        status: 'warn',
        what: 'isolation',
        detail: `none: setup, the agent and the checks run as you, your logins in reach; see ${SAFETY}`,
      },
    ]
  if (worker instanceof Error) {
    const local = env.RUNNER_ENVIRONMENT !== 'github-hosted' && process.platform === 'linux'
    const setup = [
      'make the worker user once:',
      `sudo useradd --no-create-home --user-group --shell /usr/sbin/nologin ${WORKER}`,
      `echo ${WORKER} | sudo tee -a /etc/cron.deny /etc/at.deny`,
      `sudo visudo -f /etc/sudoers.d/${WORKER}   # with these two lines:`,
      ...sudoersLines(),
    ]
    const detail = `user, but ${worker.message}${local ? `; ${setup.join('\n    ')}` : ''}`
    return [{ status: 'FAIL', what: 'isolation', detail }]
  }
  const checks: Check[] = [
    {
      status: 'ok',
      what: 'isolation',
      detail: `user: setup, the agent and the checks run as ${worker}`,
    },
  ]
  const home = homedir()
  const mode = statSync(home).mode & 0o777
  if (mode & 0o007)
    checks.push({
      status: 'warn',
      what: 'isolation',
      detail: `${home} is mode ${mode.toString(8)}, so the worker reads what's world-readable in it: chmod o-rwx ~`,
    })
  const path = (env.PATH ?? '').split(':').filter(Boolean)
  const { stdout } = await execa(
    bin('sudo'),
    [
      '-n',
      '-u',
      worker,
      '/bin/sh',
      '-c',
      'for d; do [ -x "$d" ] || echo "$d"; done',
      'sh',
      ...path,
    ],
    { reject: false },
  )
  const unreachable = stdout.split('\n').filter(Boolean)
  if (unreachable.length)
    checks.push({
      status: 'warn',
      what: 'isolation',
      detail: `${worker} can't enter ${unreachable.join(', ').replaceAll(home, '~')} on your PATH: tools there won't run as it`,
    })
  return checks
}

/** Checks that every secret the awaywork workflow names exists in the repo or the org. */
export async function workflowSecretChecks(root: string, run: Exec = exec): Promise<Check[]> {
  const file = join(root, WORKFLOW)
  if (!existsSync(file)) return []
  const failures: string[] = []
  const listed = await repoSecrets(run, (list, e) =>
    failures.push(`${list === 'repo' ? "the repo's" : "the organization's"}: ${reasonOf(e)}`),
  )
  // Without either list, a missing name can't be told from an unlisted one.
  if (failures.length)
    return [
      {
        status: 'warn',
        what: 'workflow secrets',
        detail: `couldn't list ${failures.join('; ')}`,
      },
    ]
  const checks: Check[] = []
  const what = basename(file)
  // A workflow that doesn't parse won't run either.
  try {
    const jobs = parse(await readFile(file, 'utf8'))?.jobs
    for (const job of Object.values<Job>(jobs ?? {})) checks.push(jobSecretCheck(what, job, listed))
  } catch (e) {
    checks.push({ status: 'FAIL', what, detail: (e as Error).message.split('\n')[0] ?? '' })
  }
  return checks
}

/** The parts of a workflow's job these checks read. */
interface Job {
  env?: Record<string, unknown>
  steps?: { env?: Record<string, unknown> }[]
}

/** A job's secrets, in its env or its steps'. */
function jobSecretCheck(what: string, job: Job, listed: RepoSecrets): Check {
  const envs = [job.env, ...(job.steps ?? []).map((step) => step?.env)]
  const names = [
    ...new Set(
      envs
        .flatMap((env) => Object.values(env ?? {}))
        .flatMap((value) =>
          [...String(value).matchAll(/\$\{\{\s*secrets\.(\w+)\s*\}\}/g)].map((m) => m[1] ?? ''),
        ),
    ),
  ]
  const missing = names.filter((name) => !listed.repo.has(name) && !listed.org.has(name))
  return missing.length
    ? { status: 'FAIL', what, detail: `add ${missing.join(', ')} to the repository secrets` }
    : { status: 'ok', what, detail: `secrets found: ${names.length}` }
}

/** gh's own last line of a failed call, e.g. "gh: Not Found (HTTP 404)". */
const reasonOf = (e: unknown) =>
  (
    String((e as { stderr?: string }).stderr ?? '').trim() ||
    (e instanceof Error ? e.message : String(e))
  )
    .split('\n')
    .at(-1)

interface RepoSecrets {
  repo: Set<string>
  /** The org's secrets shared with the repo. */
  org: Set<string>
}

const ghNames = async (run: Exec, args: string[]) =>
  new Set((await run('gh', args)).split('\n').filter(Boolean))

/** The names of the current repo's secrets; throws when gh can't list them. */
const secretNames = (run: Exec) =>
  ghNames(run, ['secret', 'list', '--json', 'name', '--jq', '.[].name'])

/** Lists the current repo's secrets and its org's; a list gh can't get is empty, after `failed` hears why. */
async function repoSecrets(
  run: Exec,
  failed: (list: 'repo' | 'org', e: unknown) => void,
): Promise<RepoSecrets> {
  const repo = await secretNames(run).catch((e) => {
    failed('repo', e)
    return new Set<string>()
  })
  const org = await orgSecrets(run).catch((e) => {
    failed('org', e)
    return new Set<string>()
  })
  return { repo, org }
}

/** The org's secrets shared with the repo, none for a user's repo; throws when gh can't. */
async function orgSecrets(run: Exec): Promise<Set<string>> {
  const type = await run('gh', ['api', 'repos/{owner}/{repo}', '--jq', '.owner.type'])
  // Only an org-owned repo has org secrets; listing a user's fails.
  if (type !== 'Organization') return new Set<string>()
  return ghNames(run, [
    'api',
    '--paginate',
    'repos/{owner}/{repo}/actions/organization-secrets',
    '--jq',
    '.secrets[].name',
  ])
}
