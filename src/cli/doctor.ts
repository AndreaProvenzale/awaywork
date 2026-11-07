import { existsSync, statSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import type { Command } from 'commander'
import { execa } from 'execa'
import { parse } from 'yaml'
import { ConfigError, configPath, loadConfig } from '../config/load.js'
import { expandHome, loginCommand, type Pin, pinLogins } from '../config/logins.js'
import { bin, configDir, envFile, runsDir, skillsDirIn, skillsDirOf } from '../config/paths.js'
import { type Config, canMatch } from '../config/schema.js'
import { hasSkills, unknownSkillsWarning } from '../config/skills.js'
import { allowance } from '../core/budget.js'
import {
  DOCKER_TIMEOUT_MS,
  dockerVersion,
  inAwayworkImage,
  inImage,
  sudoersLines,
  WORKER,
  workerFor,
} from '../core/launch.js'
import { counted } from '../core/report.js'
import type { Ctx, Provider } from '../core/types.js'
import { bitbucketRemote, bitbucketWorkspaces, twg } from '../forge/bitbucket.js'
import { type Exec, exec, onHost } from '../forge/gh.js'
import { codexLogin } from '../providers/codex.js'
import { commandBinary, isCommandProvider } from '../providers/command.js'
import { providerFor, providers } from '../providers/index.js'
import { staleDocker } from '../scheduler/docker.js'
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

/** Runs every check in order, handing each to onCheck as soon as it is known; without a config, which agent CLIs are here. */
export async function runChecks(path: string, onCheck: (check: Check) => void): Promise<Check[]> {
  const checks: Check[] = []
  const report = (status: Status, what: string, detail = '') => {
    const check = { status, what, detail }
    checks.push(check)
    onCheck(check)
  }
  const ctx: Ctx = { env: process.env, log: (line) => report('warn', line) }
  const secret = (name: string) => (process.env[name] ? `${name} set` : `${name} unset`)

  const loaded = await loadConfig(path, { pin: false }).catch((e: Error) => e)
  const pins = loaded instanceof Error ? [] : await pinLogins(loaded)
  const ghPin = pins.find((p) => p.what === 'gh')
  const github =
    loaded instanceof Error
      ? undefined
      : (loaded.sources.github as { user?: string; host?: string } | undefined)
  const workspaces = loaded instanceof Error ? [] : bitbucketWorkspaces(loaded)
  for (const bin of ['git', workspaces.length ? 'twg' : 'gh']) {
    const version = await exec(bin, ['--version']).catch(() => undefined)
    report(version ? 'ok' : 'FAIL', bin, version?.split('\n')[0] ?? 'not found on PATH')
  }
  if (workspaces.length && !(loaded instanceof Error))
    for (const c of await bitbucketChecks(loaded)) report(c.status, c.what, c.detail)
  else if (ghPin?.problem) report('FAIL', 'gh login', ghPin.problem)
  else
    await onHost(exec, github?.host)('gh', ['api', 'user', '--jq', '.login']).then(
      (login) => report(...ghLogin(login.trim(), github?.user, ghPin, process.env)),
      () =>
        exec('gh', ['auth', 'status']).then(
          () => report('ok', 'gh login'),
          () => report(process.env.GH_TOKEN ? 'ok' : 'FAIL', 'gh login', secret('GH_TOKEN')),
        ),
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

  if (loaded instanceof Error) {
    const what = loaded instanceof ConfigError ? loaded.path : path
    report('FAIL', what, loaded.message.split('\n').slice(1).join('; ').trim())
    for (const provider of Object.values(providers)) {
      const found = await provider.detect().catch(() => ({ installed: false, version: undefined }))
      const version = found.version ?? 'installed'
      if (!found.installed) report('warn', provider.id, 'not installed')
      else if (provider.id === 'cursor' && !process.env.CURSOR_API_KEY)
        report('warn', provider.id, `${version}, ${CURSOR_KEYLESS}`)
      else report('ok', provider.id, version)
    }
    return checks
  }
  const config = loaded
  const unknown = await unknownSkillsWarning(config, skillsDirOf(path))
  report(unknown ? 'warn' : 'ok', path, unknown)
  for (const warning of await staleSchedules(path, config.windows))
    report('warn', 'schedule', warning)
  const root = await gitRoot()
  const workflow = root && (await staleWorkflow(root))
  if (workflow) report('warn', 'schedule', workflow)
  const image = root && (await staleDocker(root))
  if (image) report('warn', 'schedule', image)
  for (const c of root ? await workflowSecretChecks(root) : []) report(c.status, c.what, c.detail)
  const boxed =
    config.isolation === 'container' &&
    process.env.RUNNER_ENVIRONMENT !== 'github-hosted' &&
    !inAwayworkImage(process.env)
  const isolation = boxed
    ? await containerChecks(config, process.env)
    : await isolationChecks(config.isolation, process.env)
  for (const c of isolation) report(c.status, c.what, c.detail)
  const asWorker = !boxed && isolation[0]?.status === 'ok'

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
    const unset = provider.secrets.filter((name) => !process.env[name])
    const keyless = id === 'cursor' && unset.length > 0
    if (keyless) report('FAIL', id, `${found.version}, ${CURSOR_KEYLESS}`)
    else
      report(
        provider.unattended === 'allowed' ? 'ok' : 'warn',
        id,
        facts.filter(Boolean).join(', '),
      )
    if (!keyless && asWorker && !provider.login && unset.length > 0)
      report('warn', id, `the ${WORKER} user can't use your login: set ${unset.join(', ')}`)
    const pin = pins.find((p) => p.what === id)
    if (provider.account) report(...(await providerLogin(provider, pin, process.env)))
    // Unpinned, it would read another login's quota.
    if (pin?.problem) continue
    await provider.probe(ctx).then(
      (quota) => {
        const a = allowance(budget, quota, Date.now(), config.windows)
        const line = describeAllowance(id, a, budget.present_session_max)
        report(a.kind === 'quota' ? 'ok' : 'warn', `${id} quota`, line)
      },
      (e: Error) => report('FAIL', `${id} probe`, e.message),
    )
  }

  for (const [id, cfg] of Object.entries(config.sources)) {
    const source = sourceFor(id, cfg)
    // Read as gh's active account, it would count someone else's items.
    if (!source || (id === 'github' && ghPin?.problem)) continue
    const secrets = source.secrets(cfg).map(secret)
    await source.items(cfg, ctx).then(
      (items) => report('ok', id, [counted(items.length, 'open item'), ...secrets].join(', ')),
      (e: Error) => report('FAIL', id, [e.message, ...secrets].join(', ')),
    )
    if (isCommand(cfg) && /(^|\s)(~|\$HOME)\//.test(cfg.command))
      report('warn', id, 'the command reads your home folder, which GitHub Actions lacks')
  }
  config.queue?.forEach((rule, i) => {
    if (!rule.on_done) return
    // A rule without `source` moves the items of the source it matched: only those it can match.
    const scope = rule.source
      ? [rule.source]
      : Object.keys(config.sources).filter((id) => canMatch(config.sources, id, rule.where))
    const { comment, move } = rule.on_done
    const lost = [comment && 'no result is posted', move && 'they stay put'].filter(Boolean)
    for (const id of scope.filter((id) => !sourceFor(id, config.sources[id])?.write))
      report('warn', `rule #${i + 1} on_done`, `${id} can't write to its items: ${lost.join(', ')}`)
  })
  for (const [name, server] of Object.entries(config.mcp)) {
    const unset = server.secrets.filter((s) => !process.env[s])
    const facts = [server.command ?? server.url, ...server.secrets.map(secret)].join(', ')
    report(unset.length > 0 ? 'warn' : 'ok', `mcp ${name}`, facts)
  }
  return checks
}

const GH_TOKENS = ['GH_TOKEN', 'GITHUB_TOKEN', 'GH_ENTERPRISE_TOKEN', 'GITHUB_ENTERPRISE_TOKEN']

/** The gh login a run uses and where it comes from; a warning when the environment's wins over another `user`. */
export function ghLogin(
  login: string,
  user: string | undefined,
  pin: Pin | undefined,
  env: NodeJS.ProcessEnv,
): [Status, string, string] {
  if (pin?.value) return ['ok', 'gh login', `${login}, pinned by ${pin.key}`]
  const token = GH_TOKENS.find((name) => env[name])
  if (user && login !== user)
    return [
      'warn',
      'gh login',
      `${login} from ${token ?? "gh's active account"}, not sources.github.user ${user}: a token in the environment wins; make it ${user}'s, or unset it`,
    ]
  return ['ok', 'gh login', `${login}, ${token ? `from ${token}` : "gh's active account"}`]
}

/** The login a provider's runs use and where it comes from; a FAIL with the fix when there's none. */
export async function providerLogin(
  provider: Provider,
  pin: Pin | undefined,
  env: NodeJS.ProcessEnv,
): Promise<[Status, string, string]> {
  const what = `${provider.id} login`
  if (pin?.problem) return ['FAIL', what, pin.problem]
  const token = provider.secrets.find((name) => env[name])
  if (token) return ['ok', what, pin ? `${token}, which wins over ${pin.key}` : token]
  const { loginDir, account } = provider
  if (!loginDir || !account) return ['ok', what, '']
  const dir = tilde(env[loginDir.env] || loginDir.default)
  const where = `in ${dir}${pin ? `, pinned by ${pin.key}` : ''}`
  const fix = `log in with ${loginCommand(loginDir, dir)}`
  // The binary would make the folder, as `claude auth status` does.
  if (!existsSync(expandHome(dir))) return ['FAIL', what, `${dir} doesn't exist; ${fix}`]
  return account(env).then(
    (who): [Status, string, string] => ['ok', what, `${who}, ${where}`],
    (): [Status, string, string] => ['FAIL', what, `no login ${where}; ${fix}`],
  )
}

const tilde = (path: string) => {
  const home = homedir()
  return path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path
}

const CURSOR_KEYLESS =
  "CURSOR_API_KEY unset: Cursor runs in a HOME of awaywork's, where your login doesn't reach; make a key in Cursor's dashboard and put it in the env file"

const SAFETY = 'https://andreaprovenzale.github.io/awaywork/guide/safety#not-a-sandbox'

/**
 * twg's login per workspace, and one SSH push path that needs no passphrase: under launchd or cron
 * there's no agent to ask. A login whose storage isn't a file is one awaywork's masking is unverified on.
 */
export async function bitbucketChecks(config: Config, run: Exec = exec): Promise<Check[]> {
  const checks: Check[] = []
  const check = (status: Status, what: string, detail = '') => checks.push({ status, what, detail })
  const login = 'log in with twg setup bitbucket, or set TWG_BBC_TOKEN'
  const workspaces = bitbucketWorkspaces(config)
  for (const w of workspaces)
    await twg(run, ['bb', 'workspace', 'get', '-w', w]).then(
      () => check('ok', `twg ${w}`),
      (e: Error) => check('FAIL', `twg ${w}`, `${e.message.replace(/\.$/, '')}; ${login}`),
    )
  const repos = (config.sources.bitbucket as { repos: string[] }).repos
  const any = ['bb', 'repo', 'query', '-w', workspaces[0] ?? '', '-n', '1']
  const repo =
    repos.find((r) => !r.includes('*')) ??
    (await twg<{ full_name: string }[]>(run, any)
      .then(([r]) => r?.full_name)
      .catch(() => undefined))
  const ssh =
    process.env.GIT_SSH_COMMAND ||
    (await run('git', ['config', '--get', 'core.sshCommand']).catch(() => '')).trim() ||
    (process.env.GIT_SSH ? '' : 'ssh')
  // A GIT_SSH wrapper may be plink, which takes no -o: leave it to git
  const batch = ssh ? { GIT_SSH_COMMAND: `${ssh} -o BatchMode=yes` } : undefined
  if (repo)
    await run('git', ['ls-remote', bitbucketRemote(repo), 'HEAD'], batch).then(
      () => check('ok', 'git over ssh', repo),
      (e: Error & { stderr?: string }) =>
        check(
          'FAIL',
          'git over ssh',
          `${repo}: ${(e.stderr || e.message).trim().split('\n')[0]?.replace(/\.$/, '')}; add a key without a passphrase to Bitbucket, or keep one in an agent the scheduler sees`,
        ),
    )
  const storage = await twg<{ data: { authority: string } }>(run, ['auth', 'storage', 'status'])
    .then((s) => s.data.authority)
    .catch(() => undefined)
  if (storage && storage !== 'file')
    check(
      'warn',
      'twg login',
      `stored in ${storage}: masking it from workers is verified only for file storage`,
    )
  return checks
}

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
    const local =
      env.RUNNER_ENVIRONMENT !== 'github-hosted' &&
      !inAwayworkImage(env) &&
      process.platform === 'linux'
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

/** Under `isolation: container`: docker answers, each repo's image is here with the agents' CLIs in it, and the logins a container can use. */
export async function containerChecks(
  config: Config,
  env: NodeJS.ProcessEnv,
  timeout = DOCKER_TIMEOUT_MS,
): Promise<Check[]> {
  const check = (status: Status, detail: string): Check => ({ status, what: 'isolation', detail })
  const version = await dockerVersion(timeout).catch((e: Error) => e)
  if (version instanceof Error) return [check('FAIL', `container, but ${version.message}`)]
  const checks = [
    check(
      'ok',
      `container: setup, the agent and the checks run in a fresh container of the repo's image (Docker ${version})`,
    ),
  ]
  const docker = (...args: string[]) => execa(bin('docker'), args, { reject: false, timeout })
  const clis = config.providers.map(({ id, config: cfg }) =>
    isCommandProvider(cfg)
      ? { id, command: ['/bin/sh', '-c', 'command -v "$0"', commandBinary(cfg.command)] }
      : { id, command: [providerFor(id, cfg)?.bin ?? id, '--version'] },
  )
  let mounted = false
  for (const [repo, { image }] of Object.entries(config.repos)) {
    if (!image) continue
    if ((await docker('image', 'inspect', image)).failed) {
      const pulled = await execa(bin('docker'), ['pull', '--quiet', image], {
        reject: false,
        timeout: 10 * timeout,
      })
      if (pulled.failed) {
        const why = pulled.stderr.trim().split('\n').at(-1) || pulled.shortMessage
        checks.push(check('FAIL', `${repo}: ${image} isn't here and couldn't be pulled (${why})`))
        continue
      }
    }
    if (!mounted) {
      mounted = true
      await mkdir(runsDir, { recursive: true })
      // An empty folder shares the runs dir's mount path without showing the image any past run.
      const probe = await mkdtemp(join(runsDir, '.mount-check-'))
      const ran = await docker(...inImage(image, ['true'], [probe]))
      await rm(probe, { recursive: true, force: true })
      if (ran.failed) {
        const why = ran.stderr.trim().split('\n')[0] || ran.shortMessage
        checks.push(
          check(
            'FAIL',
            `the engine can't mount ${runsDir}, where the clones go (${why}): share it with the engine's VM`,
          ),
        )
      }
    }
    const found: string[] = []
    const missing: string[] = []
    for (const { id, command } of clis) {
      const ran = await docker(...inImage(image, command))
      if (ran.failed) missing.push(id)
      else found.push(`${id} ${ran.stdout.trim().split('\n')[0]}`)
    }
    if (found.length) checks.push(check('ok', `${repo}: ${image} has ${found.join(', ')}`))
    if (missing.length)
      checks.push(
        check('warn', `${repo}: ${image} can't run ${missing.join(', ')}: its units fail there`),
      )
  }
  const ids = config.providers.map((p) => p.id)
  if (ids.includes('claude') && !env.CLAUDE_CODE_OAUTH_TOKEN)
    checks.push(
      check(
        'warn',
        "CLAUDE_CODE_OAUTH_TOKEN unset: a container can't see your keychain login; make one with claude setup-token and put it in the env file",
      ),
    )
  if (ids.includes('codex') && !existsSync(codexLogin(env)))
    checks.push(
      check(
        'warn',
        `no ${codexLogin(env)} to lend the container: Codex needs its login in a file (codex login)`,
      ),
    )
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
