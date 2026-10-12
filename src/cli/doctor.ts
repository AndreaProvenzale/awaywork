import { existsSync, statSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { basename, dirname, resolve } from 'node:path'
import type { Command } from 'commander'
import { parse } from 'yaml'
import { configPath, loadConfig } from '../config/load.js'
import { configDir, envFile, skillsDirIn, skillsDirOf } from '../config/paths.js'
import type { Config } from '../config/schema.js'
import { hasSkills } from '../config/skills.js'
import { allowance } from '../core/budget.js'
import type { Ctx } from '../core/types.js'
import { type Exec, exec } from '../forge/gh.js'
import { providers } from '../providers/index.js'
import { staleWorkflow, suffixOf, workflows } from '../scheduler/github-actions.js'
import { isCommand } from '../sources/command.js'
import { sourceFor } from '../sources/index.js'
import { describeAllowance, type Status, statusMarker } from './format.js'
import {
  gitRoot,
  leftoverWarning,
  type RepoSecrets,
  reasonOf,
  repoSecrets,
  secretNames,
  staleSchedules,
} from './schedule.js'

export interface Check {
  status: Status
  what: string
  detail: string
}

export function doctorCommand(program: Command): void {
  program
    .command('doctor')
    .description('check binaries, credentials, quota and sources before a run')
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
    report('ok', path)
  } catch (e) {
    report('FAIL', path, (e as Error).message.split('\n').slice(1).join('; ').trim())
    return checks
  }
  for (const warning of await staleSchedules(path, config.windows))
    report('warn', 'schedule', warning)
  const root = await gitRoot()
  const workflow = root && (await staleWorkflow(root))
  if (workflow) report('warn', 'schedule', workflow)
  for (const c of root ? await workflowSecretChecks(root) : []) report(c.status, c.what, c.detail)

  for (const { id, budget } of config.providers) {
    const provider = providers[id]
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
    await provider.probe(ctx).then(
      (quota) => {
        const a = allowance(budget, quota, Date.now(), config.windows)
        report(a.kind === 'quota' ? 'ok' : 'warn', `${id} quota`, describeAllowance(a))
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

/** Checks that every secret each awaywork workflow names exists in its environment, the repo or the org. */
export async function workflowSecretChecks(root: string, run: Exec = exec): Promise<Check[]> {
  const files = await workflows(root)
  if (!files.length) return []
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
  for (const file of files) {
    const what = basename(file)
    // A workflow that doesn't parse won't run either.
    try {
      const jobs = parse(await readFile(file, 'utf8'))?.jobs
      for (const job of Object.values<Job>(jobs ?? {}))
        checks.push(...(await jobSecretChecks(what, job, listed, run)))
    } catch (e) {
      checks.push({ status: 'FAIL', what, detail: (e as Error).message.split('\n')[0] ?? '' })
    }
  }
  return checks
}

/** The parts of a workflow's job these checks read. */
interface Job {
  environment?: string | { name?: string }
  env?: Record<string, unknown>
  steps?: { env?: Record<string, unknown> }[]
}

/** A job's secrets, in its env or its steps'; in an environment, the person's own are the names with their suffix. */
async function jobSecretChecks(
  what: string,
  job: Job,
  listed: RepoSecrets,
  run: Exec,
): Promise<Check[]> {
  const environment = typeof job.environment === 'string' ? job.environment : job.environment?.name
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
  const own = environment
    ? await secretNames(run, environment).catch((e: Error) => e)
    : new Set<string>()
  if (own instanceof Error)
    return [
      {
        status: 'warn',
        what,
        detail: `couldn't list environment ${environment}'s secrets: ${reasonOf(own)}`,
      },
    ]
  const personal = (name: string) => !!environment && name.endsWith(suffixOf(environment))
  const missing = names.filter(
    (name) => !own.has(name) && !listed.repo.has(name) && !listed.org.has(name),
  )
  const toEnvironment = missing.filter(personal)
  const toRepo = missing.filter((name) => !personal(name))
  const checks: Check[] = [
    missing.length
      ? {
          status: 'FAIL',
          what,
          detail: [
            toEnvironment.length && `add ${toEnvironment.join(', ')} to environment ${environment}`,
            toRepo.length && `add ${toRepo.join(', ')} to the repository secrets`,
          ]
            .filter(Boolean)
            .join('; '),
        }
      : { status: 'ok', what, detail: `secrets found: ${names.length}` },
  ]
  const leftovers = names.filter((name) => personal(name) && listed.repo.has(name))
  if (environment && leftovers.length)
    checks.push({ status: 'warn', what, detail: leftoverWarning(environment, leftovers) })
  return checks
}
