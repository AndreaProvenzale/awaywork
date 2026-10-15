import { existsSync, realpathSync, statSync } from 'node:fs'
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import type { Command } from 'commander'
import { execa } from 'execa'
import { ConfigError, configPath, loadConfig } from '../config/load.js'
import { bin, packageVersion, skillsDirOf, stateDir } from '../config/paths.js'
import type { Config } from '../config/schema.js'
import { hasSkills } from '../config/skills.js'
import type { Ask } from '../core/types.js'
import { describeWindow, startsOf, type Window } from '../core/window.js'
import { type Exec, exec } from '../forge/gh.js'
import { providers } from '../providers/index.js'
import {
  isPlainSelfHosted,
  isSelfHosted,
  REPO_CONFIG,
  removeWorkflow,
  runsOnOf,
  WORKFLOW,
  workflow,
  workflows,
} from '../scheduler/github-actions.js'
import {
  defaultScheduler,
  describeStarts,
  type Schedule,
  type Scheduler,
  SchedulerError,
  type Start,
  schedulers,
} from '../scheduler/index.js'
import { keepAwake, wakeFor, wakeUndo } from '../scheduler/wake.js'
import { isCommand } from '../sources/command.js'
import { sourceFor } from '../sources/index.js'
import { Cancelled, terminalAsk } from './ask.js'
import { reportConfigError } from './config.js'

const GITHUB_ACTIONS = 'github-actions'
const GH_TOKEN_HELP =
  'GH_TOKEN is a classic personal access token of yours with the `repo` and `workflow` scopes ' +
  '(https://github.com/settings/tokens/new?scopes=repo,workflow): `repo` reads your PRs, issues, ' +
  'checks and Actions logs, pushes new branches and opens draft PRs; `workflow` lets it push ' +
  'branches that change workflow files'

export function scheduleCommand(program: Command): void {
  const schedule = program
    .command('schedule')
    .description('run awaywork when its windows open, on this machine or in GitHub Actions')

  schedule
    .command('install')
    .description('start `awaywork run` when a window opens; it starts no unit after it closes')
    .option(
      '--with <scheduler>',
      `${[...Object.keys(localSchedulers()), GITHUB_ACTIONS].join(', ')} (default: asks in a terminal, else launchd on macOS, else systemd if it runs, else cron)`,
    )
    .action((opts: { with?: string }) => installSchedule(program.opts().config, opts.with))

  schedule
    .command('remove')
    .description(`remove the scheduled job, and ${WORKFLOW} in the current repo`)
    .action(async () => {
      const removed = []
      for (const scheduler of Object.values(localSchedulers()))
        if (await scheduler.remove()) removed.push(scheduler.id)
      const root = await gitRoot()
      if (root && (await removeWorkflow(root))) removed.push(GITHUB_ACTIONS)
      console.log(
        removed.length ? `Removed the ${removed.join(', ')} job` : 'No scheduled job installed',
      )
      const undo = await wakeUndo(exec)
      if (undo) console.log(undo)
    })

  schedule
    .command('status')
    .description('show the installed scheduled job')
    .action(async () => {
      let found = false
      for (const scheduler of Object.values(localSchedulers())) {
        const job = await scheduler.read()
        if (!job) continue
        found = true
        console.log(`Scheduled with ${scheduler.id} at ${describeStarts(job.starts)}`)
        console.log(`Config: ${jobConfig(job) ?? 'the default'}`)
        console.log(`Log: ${job.log}`)
      }
      const root = await gitRoot()
      for (const file of root ? await workflows(root) : []) {
        found = true
        console.log(`Scheduled with ${GITHUB_ACTIONS}: ${file}`)
      }
      if (!found) console.log('No scheduled job installed')
    })
}

const localSchedulers = () => schedulers(homedir(), exec)

function jobConfig(job: Schedule): string | undefined {
  const flag = job.command.indexOf('--config')
  return flag >= 0 ? job.command[flag + 1] : undefined
}

const startsKey = (starts: Start[]) =>
  starts
    .map((s) => describeStarts([s]))
    .sort()
    .join()

/** Warns about each installed job for this config that no longer starts when its windows open. */
export async function staleSchedules(
  config: string,
  windows: Window[],
  all: Record<string, Scheduler> = localSchedulers(),
): Promise<string[]> {
  const warnings = []
  for (const scheduler of Object.values(all)) {
    const job = await scheduler.read()
    if (!job || jobConfig(job) !== resolve(config)) continue
    const wanted = startsOf(windows)
    if (startsKey(job.starts) !== startsKey(wanted))
      warnings.push(
        `the ${scheduler.id} job starts at ${describeStarts(job.starts)}, the config's windows start at ${describeStarts(wanted)}; run \`awaywork schedule install\``,
      )
  }
  return warnings
}

export const gitRoot = (run: Exec = exec) =>
  run('git', ['rev-parse', '--show-toplevel']).catch(() => undefined)

/** The `--with` value: '' for this machine's default scheduler. */
export const whereToRun = (ask: Ask, later = false) =>
  ask.select(
    'Where should it run on a schedule?',
    [
      { value: '', label: 'this machine' },
      { value: GITHUB_ACTIONS, label: 'GitHub Actions, from the repo in this directory' },
      ...(later ? [{ value: 'later', label: 'later, with awaywork schedule install' }] : []),
    ],
    '',
  )

/**
 * Installs the scheduled job with the named scheduler, '' for the platform's default; without
 * one, asks in a terminal, else takes the default.
 */
export async function installSchedule(
  config: string | undefined,
  id?: string,
  io: Io = terminal,
): Promise<void> {
  if (id === undefined && io.interactive)
    try {
      id = await whereToRun(io.ask)
    } catch (e) {
      return cancelled(e)
    }
  if (id === GITHUB_ACTIONS) return installWorkflow(config, io)
  const all = localSchedulers()
  const scheduler = all[id || defaultScheduler()]
  if (!scheduler) {
    console.error(
      `unknown scheduler "${id}"; use ${[...Object.keys(all), GITHUB_ACTIONS].join(', ')}`,
    )
    process.exitCode = 1
    return
  }
  try {
    const path = resolve(configPath(config))
    const { windows } = await loadConfig(path)
    const bin = realpathSync(process.argv[1] ?? '')
    const log = join(stateDir, 'schedule.log')
    await mkdir(stateDir, { recursive: true })
    const starts = startsOf(windows)
    const awake = await keepAwake(io.run)
    const where = await scheduler.install({
      command: [...awake, process.execPath, bin, 'run', '--scheduled', '--config', path],
      starts,
      path: process.env.PATH ?? '',
      log,
    })
    for (const other of Object.values(all))
      if (other !== scheduler && (await other.remove())) console.log(`Removed the ${other.id} job`)
    console.log(
      `Scheduled with ${scheduler.id} for ${windows.map(describeWindow).join(', ')}: ${where}`,
    )
    console.log(`Log: ${log}. The job keeps this shell's PATH; secrets come from the env file.`)
    if (scheduler.id === 'systemd')
      console.log(
        'User timers run only while you are logged in; `loginctl enable-linger` lifts that.',
      )
    await offerWake(starts, io)
  } catch (e) {
    if (!(e instanceof SchedulerError)) return reportConfigError(e)
    console.error(e.message)
    process.exitCode = 1
  }
}

/** Offers to wake the machine when a window opens; sudo asks for a password, so only in a terminal. */
async function offerWake(starts: Start[], io: Io): Promise<void> {
  const wake = await wakeFor(starts, io.run)
  if (typeof wake === 'string') return console.log(wake)
  if (!wake) return
  if (!io.interactive)
    return console.log(
      '`awaywork schedule install` in a terminal also wakes this machine for the runs',
    )
  try {
    if (!(await io.ask.confirm(wake.question, wake.initial))) return
  } catch (e) {
    if (e instanceof Cancelled) return
    throw e
  }
  try {
    await wake.install()
    console.log('This machine wakes when a window opens')
  } catch (e) {
    const { stderr } = e as { stderr?: string }
    console.error(`No wake set: ${stderr?.trim() || (e instanceof Error ? e.message : String(e))}`)
    process.exitCode = 1
  }
}

/** What install reaches outside the repo's files; injected so tests replay gh. */
export interface Io {
  run: Exec
  ask: Ask
  env: NodeJS.ProcessEnv
  /** Runs `gh secret set` with these args, the value on stdin. */
  setSecret: (args: string[], value: string) => Promise<void>
  /**
   * Asks what the flags leave open, offers secrets and confirms replacements; otherwise keeps
   * what the repo has, or the defaults.
   */
  interactive?: boolean
}

/** Sets a secret of the current repo; the value goes through stdin, never argv. */
const ghSecretSet = async (args: string[], value: string) =>
  void (await execa('gh', ['secret', 'set', ...args], { input: value }))

/** The Ask for confirming a replacement; none without a terminal. */
const confirmer = (io: Io) => (io.interactive ? io.ask : undefined)

const terminal: Io = {
  run: exec,
  ask: terminalAsk,
  env: process.env,
  setSecret: ghSecretSet,
  interactive: Boolean(process.stdin.isTTY),
}

/** Reports a prompt the user left; rethrows anything else. */
function cancelled(e: unknown): void {
  if (!(e instanceof Cancelled)) throw e
  console.error('Cancelled')
  process.exitCode = 1
}

/** The secrets a config needs on a runner. */
const secretsOf = (config: Config) => [
  ...new Set([
    'GH_TOKEN',
    ...config.providers.flatMap((p) => providers[p.id]?.secrets ?? []),
    ...Object.entries(config.sources).flatMap(
      ([id, cfg]) => sourceFor(id, cfg)?.secrets(cfg) ?? [],
    ),
    ...(config.notify?.secrets ?? []),
    ...(config.after_unit?.secrets ?? []),
    ...Object.values(config.repos).flatMap((r) => r.secrets),
    ...Object.values(config.mcp).flatMap((s) => s.secrets),
  ]),
]

/** Writes the workflow and copies the config and skills into the repo; run again, it syncs them. */
export async function installWorkflow(
  config: string | undefined,
  io: Io = terminal,
): Promise<void> {
  const root = await gitRoot(io.run)
  if (!root) {
    console.error('GitHub Actions runs from a repo; run this inside a git repository')
    process.exitCode = 1
    return
  }
  try {
    const path = configPath(config)
    const loaded = await loadConfig(path)
    const current = await readFile(join(root, WORKFLOW), 'utf8').catch(() => '')
    const selfHosted = io.interactive
      ? await askSelfHosted(io.ask, isSelfHosted(current))
      : isSelfHosted(current)
    const runner = selfHosted ? 'self-hosted' : 'github-hosted'
    const used = loaded.providers.flatMap((p) => {
      const provider = providers[p.id]
      const unavailable = provider?.unavailable?.({ RUNNER_ENVIRONMENT: runner })
      if (unavailable) console.log(`${p.id} won't run in this workflow: ${unavailable}`)
      return provider && !unavailable ? [provider] : []
    })
    const base = {
      starts: startsOf(loaded.windows),
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      version: packageVersion,
      // A self-hosted runner keeps the machine's own CLIs and their logins.
      packages: selfHosted ? [] : used.map((p) => p.package),
      setup: Object.values(loaded.sources).flatMap((cfg) =>
        isCommand(cfg) && cfg.setup ? [cfg.setup] : [],
      ),
      // A label picking the machine, as in `[self-hosted, macOS]`, stays.
      runsOn: selfHosted
        ? (isSelfHosted(current) && runsOnOf(current)) || 'self-hosted'
        : 'ubuntu-latest',
    }
    if (selfHosted && (base.runsOn === 'self-hosted' || isPlainSelfHosted(current)))
      console.log(
        "`runs-on: self-hosted` matches any self-hosted runner the repo can use, an organization's too; give yours a label of its own and add it, as in `runs-on: [self-hosted, alice-mac]`",
      )
    const secrets = secretsOf(loaded)
    const text = workflow({ ...base, config: REPO_CONFIG, secrets })
    const changed = await syncRepo(root, WORKFLOW, text, path, REPO_CONFIG, confirmer(io))
    const unset = io.interactive
      ? await offerSecrets(secrets, io.env, io.ask, io.setSecret).catch((e) => {
          if (e instanceof Cancelled) return secrets
          throw e
        })
      : secrets
    if (changed.length || unset.length) console.log('Before the first run:')
    if (changed.length) console.log(`  commit ${and(changed)}`)
    if (unset.length) console.log(`  add these repository secrets: ${unset.join(', ')}`)
    if (unset.includes('GH_TOKEN')) console.log(`  ${GH_TOKEN_HELP}`)
  } catch (e) {
    if (!(e instanceof Cancelled)) return reportConfigError(e)
    cancelled(e)
  }
}

const askSelfHosted = async (ask: Ask, selfHosted: boolean) =>
  (await ask.select(
    'Which runner?',
    [
      { value: 'github-hosted', label: 'GitHub-hosted', hint: 'a fresh VM each run, no Codex' },
      {
        value: 'self-hosted',
        label: 'self-hosted',
        hint: "a machine of yours added as this repo's runner, on its own codex login",
      },
    ],
    selfHosted ? 'self-hosted' : 'github-hosted',
  )) === 'self-hosted'

/** gh's own last line of a failed call, e.g. "gh: Must have admin rights to Repository. (HTTP 403)". */
export const reasonOf = (e: unknown) =>
  (
    String((e as { stderr?: string }).stderr ?? '').trim() ||
    (e instanceof Error ? e.message : String(e))
  )
    .split('\n')
    .at(-1)

export interface RepoSecrets {
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
export async function repoSecrets(
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

/** Syncs the workflow, then the config and the user's skills beside it; returns what it wrote. */
async function syncRepo(
  root: string,
  file: string,
  text: string,
  path: string,
  config: string,
  ask?: Ask,
): Promise<string[]> {
  const changed = []
  if (await sync(root, file, ask, (staged) => writeFile(staged, text))) {
    console.log(`Wrote ${file}`)
    changed.push(file)
  }
  if (await syncCopy(path, root, config, ask)) changed.push(config)
  const skills = skillsDirOf(path)
  if ((await hasSkills(skills)) && (await syncCopy(skills, root, skillsDirOf(config), ask)))
    changed.push(skillsDirOf(config))
  return changed
}

const and = (names: string[]) =>
  [names.slice(0, -1).join(', '), names.at(-1)].filter(Boolean).join(' and ')

/**
 * Copies `from`, a file or a folder replaced as a whole, to `to` under the repo root; when the
 * repo's copy differs, only after showing the diff and asking, and never without `ask`.
 * True when it copied.
 */
async function syncCopy(from: string, root: string, to: string, ask?: Ask): Promise<boolean> {
  // A linked skill is committed as its files, not as a link to this machine.
  const stage = (staged: string) => cp(from, staged, { recursive: true, dereference: true })
  const copied = await sync(root, to, ask, stage)
  if (copied) console.log(`Copied ${from} to ${to}`)
  return copied
}

/** Puts what `stage` writes at `to` under the repo root, as syncCopy does; true when it did. */
async function sync(
  root: string,
  to: string,
  ask: Ask | undefined,
  stage: (staged: string) => Promise<void>,
): Promise<boolean> {
  const tmp = await mkdtemp(join(tmpdir(), 'awaywork-'))
  try {
    const staged = join(tmp, basename(to))
    await stage(staged)
    const target = join(root, to)
    if (existsSync(target)) {
      const diff = await execa(bin('git'), ['diff', '--no-index', '--', target, staged], {
        reject: false,
      })
      if (diff.exitCode === 0) {
        console.log(`${to} is up to date`)
        return false
      }
      if (diff.exitCode !== 1) throw new ConfigError(to, [`git diff failed: ${diff.stderr.trim()}`])
      console.log(diff.stdout)
      if (!ask) {
        console.log(`Kept ${to}; run this again in a terminal to replace it`)
        process.exitCode = 1
        return false
      }
      const folder = statSync(staged).isDirectory()
      const question = folder
        ? `Replace all of ${to} with the changes above, deleting anything only the repo's copy has?`
        : `Overwrite ${to} with the changes above?`
      // Enter after a long diff must not delete a skill only the repo has.
      if (!(await ask.confirm(question, !folder))) {
        console.log(`Kept ${to}`)
        return false
      }
      await rm(target, { recursive: true })
    }
    await mkdir(dirname(target), { recursive: true })
    await cp(staged, target, { recursive: true })
    return true
  } finally {
    await rm(tmp, { recursive: true })
  }
}

/**
 * Offers to set each secret whose value is in the env, the env file included;
 * returns the names left unset. Values are never printed.
 */
export async function offerSecrets(
  names: string[],
  env: NodeJS.ProcessEnv,
  ask: Ask,
  set: Io['setSecret'],
): Promise<string[]> {
  const unset = []
  for (const name of names) {
    const value = env[name]
    if (value && (await ask.confirm(`Set the ${name} repository secret from your env?`))) {
      try {
        await set([name], value)
        ask.note(`Set ${name}`)
        continue
      } catch {
        ask.note(`\`gh secret set ${name}\` failed`)
      }
    }
    unset.push(name)
  }
  return unset
}
