import { existsSync, realpathSync, statSync } from 'node:fs'
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import type { Command } from 'commander'
import { execa } from 'execa'
import { ConfigError, configPath, loadConfig } from '../config/load.js'
import {
  bin,
  packageVersion,
  skillsDirOf,
  stateDir,
  watchLockPath,
  watchLogPath,
} from '../config/paths.js'
import type { Config } from '../config/schema.js'
import { hasSkills } from '../config/skills.js'
import { lockHolder } from '../core/run-lock.js'
import type { Ask, Provider } from '../core/types.js'
import { describeWindow, startsOf, type Window } from '../core/window.js'
import { type Exec, exec } from '../forge/gh.js'
import { providerFor } from '../providers/index.js'
import {
  isPlainSelfHosted,
  isSelfHosted,
  REPO_CONFIG,
  removeWorkflow,
  runsOnOf,
  WORKFLOW,
  workflow,
} from '../scheduler/github-actions.js'
import {
  defaultScheduler,
  olderJob,
  type Schedule,
  type Scheduler,
  SchedulerError,
  type Start,
  schedulers,
} from '../scheduler/index.js'
import { staleWake, wakeFor, wakeUndo } from '../scheduler/wake.js'
import { isCommand } from '../sources/command.js'
import { sourceFor } from '../sources/index.js'
import { contextSecrets } from '../worker/context.js'
import { Cancelled, printBrand, terminalAsk } from './ask.js'
import { reportConfigError } from './config.js'
import { stopWatch, watchStatus } from './watch.js'

const GITHUB_ACTIONS = 'github-actions'
const GH_TOKEN_HELP =
  'GH_TOKEN is a classic personal access token of yours with the `repo`, `workflow` and `read:org` ' +
  'scopes (https://github.com/settings/tokens/new?scopes=repo,workflow,read:org): `repo` reads your ' +
  'PRs, issues, checks and Actions logs, pushes new branches and opens draft PRs; `workflow` lets ' +
  'it push branches that change workflow files; `read:org` tells private org members from outsiders'

export function scheduleCommand(program: Command): void {
  const schedule = program
    .command('schedule')
    .description('run awaywork when its windows open, on this machine or in GitHub Actions')

  schedule
    .command('install')
    .description('keep `awaywork watch` running, which starts a run when a window opens')
    .option(
      '--with <scheduler>',
      `${[...Object.keys(localSchedulers()), GITHUB_ACTIONS].join(', ')} (default: asks in a terminal, else launchd on macOS, else systemd if it runs, else cron)`,
    )
    .action((opts: { with?: string }) => {
      printBrand()
      return installSchedule(program.opts().config, opts.with)
    })

  schedule
    .command('remove')
    .description(`remove the scheduled job, and ${WORKFLOW} in the current repo`)
    .action(async () => {
      if (insideWatch()) return
      const stuck = await stopWatch()
      if (stuck)
        console.log(
          `awaywork watch (pid ${stuck}) hasn't exited after 2 minutes; it does once its run publishes`,
        )
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
    .description('show the installed scheduled job and what awaywork watch is doing')
    .action(() => printStatus(program.opts().config))
}

/** The installed jobs, and the daemon when a job keeps it running or it runs anyway. */
export async function printStatus(
  config: string | undefined,
  all: Record<string, Scheduler> = localSchedulers(),
): Promise<void> {
  let found = false
  let watched: string | undefined
  for (const scheduler of Object.values(all)) {
    const job = await scheduler.read()
    if (!job) continue
    found = true
    console.log(
      olderJob(job)
        ? `Scheduled with ${scheduler.id}, installed by an older awaywork; run \`awaywork schedule install\` again`
        : `Scheduled with ${scheduler.id}, keeping awaywork watch running`,
    )
    console.log(`Config: ${jobConfig(job) ?? 'the default'}`)
    console.log(`Log: ${job.log}`)
    if (!olderJob(job)) watched = jobConfig(job) ?? configPath(config)
  }
  const root = await gitRoot()
  if (root && existsSync(join(root, WORKFLOW))) {
    found = true
    console.log(`Scheduled with ${GITHUB_ACTIONS}: ${join(root, WORKFLOW)}`)
  }
  if (!found) console.log('No scheduled job installed')
  if (watched || (await lockHolder(watchLockPath)))
    for (const line of await watchStatus(watched ?? configPath(config))) console.log(line)
}

/** Refuses, saying so, in a process awaywork watch started: stopping the daemon would stop this too. */
function insideWatch(): boolean {
  if (!process.env.AWAYWORK_WATCH) return false
  console.error(
    "awaywork watch started this, so it can't change the schedule; do it from a terminal",
  )
  process.exitCode = 1
  return true
}

const localSchedulers = () => schedulers(homedir(), exec)

function jobConfig(job: Schedule): string | undefined {
  const flag = job.command.indexOf('--config')
  return flag >= 0 ? job.command[flag + 1] : undefined
}

/** Warns about an installed job for this config an older awaywork installed, or whose wake no longer lands on the windows' start. */
export async function staleSchedules(
  config: string,
  windows: Window[],
  all: Record<string, Scheduler> = localSchedulers(),
  run: Exec = exec,
): Promise<string[]> {
  for (const scheduler of Object.values(all)) {
    const job = await scheduler.read()
    if (!job || jobConfig(job) !== resolve(config)) continue
    if (olderJob(job))
      return [
        `the ${scheduler.id} job was installed by an older awaywork; run \`awaywork schedule install\` again`,
      ]
    const wake = await staleWake(startsOf(windows), run)
    return wake ? [wake] : []
  }
  return []
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
    if (insideWatch()) return
    const stuck = await stopWatch()
    if (stuck) {
      console.error(
        `awaywork watch (pid ${stuck}) hasn't exited after 2 minutes; run \`awaywork schedule install\` again once it has`,
      )
      process.exitCode = 1
      return
    }
    const where = await scheduler.install({
      command: [process.execPath, bin, 'watch', '--config', path],
      path: process.env.PATH ?? '',
      log,
    })
    for (const other of Object.values(all))
      if (other !== scheduler && (await other.remove())) console.log(`Removed the ${other.id} job`)
    console.log(
      `Scheduled awaywork watch with ${scheduler.id}${windows.length ? ` for ${windows.map(describeWindow).join(', ')}` : ', no windows yet'}: ${where}`,
    )
    console.log(
      `Log: ${watchLogPath}, crashes in ${log}. The job keeps this shell's PATH; secrets come from the env file.`,
    )
    if (scheduler.id === 'systemd')
      console.log(
        'User services run only while you are logged in; `loginctl enable-linger` lifts that.',
      )
    const starts = startsOf(windows)
    if (starts.length) await offerWake(starts, io)
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
  /** Runs `gh secret set <name>`, the value on stdin. */
  setSecret: (name: string, value: string) => Promise<void>
  /**
   * Asks what the flags leave open, offers secrets and confirms replacements; otherwise keeps
   * what the repo has, or the defaults.
   */
  interactive?: boolean
}

/** Sets a secret of the current repo; the value goes through stdin, never argv. */
const ghSecretSet = async (name: string, value: string) =>
  void (await execa('gh', ['secret', 'set', name], { input: value }))

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
const secretsOf = (config: Config, providers: Provider[]) => [
  ...new Set([
    'GH_TOKEN',
    ...providers.flatMap((p) => p.secrets),
    ...Object.entries(config.sources).flatMap(
      ([id, cfg]) => sourceFor(id, cfg)?.secrets(cfg) ?? [],
    ),
    ...contextSecrets(config),
    ...(config.notify?.secrets ?? []),
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
    if (loaded.sources.bitbucket) {
      console.error(
        'GitHub Actions runs only with the GitHub forge; schedule a Bitbucket config with launchd, systemd or cron',
      )
      process.exitCode = 1
      return
    }
    const soon = (loaded.queue ?? []).flatMap((r, i) => (r.run === 'soon' ? [`#${i + 1}`] : []))
    if (soon.length)
      console.log(
        `run: soon needs awaywork watch, which GitHub Actions doesn't have: ${soon.length === 1 ? 'rule' : 'rules'} ${and(soon)} run in the windows like the rest`,
      )
    const current = await readFile(join(root, WORKFLOW), 'utf8').catch(() => '')
    const selfHosted = io.interactive
      ? await askSelfHosted(io.ask, isSelfHosted(current))
      : isSelfHosted(current)
    const runner = selfHosted ? 'self-hosted' : 'github-hosted'
    const used = loaded.providers.flatMap((p) => {
      const provider = providerFor(p.id, p.config)
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
    const secrets = secretsOf(loaded, used)
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
        await set(name, value)
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
