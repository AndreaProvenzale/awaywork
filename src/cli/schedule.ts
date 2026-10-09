import { existsSync, realpathSync, statSync } from 'node:fs'
import { cp, mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import type { Command } from 'commander'
import { execa } from 'execa'
import { configPath, loadConfig } from '../config/load.js'
import { bin, packageVersion, skillsDirOf, stateDir } from '../config/paths.js'
import type { Ask } from '../core/types.js'
import { describeWindow, startsOf, type Window, windowsOf } from '../core/window.js'
import { type Exec, exec } from '../forge/gh.js'
import { providers } from '../providers/index.js'
import {
  REPO_CONFIG,
  REPO_SKILLS,
  removeWorkflow,
  WORKFLOW,
  workflow,
} from '../scheduler/github-actions.js'
import {
  defaultScheduler,
  describeStarts,
  type Schedule,
  type Scheduler,
  type Start,
  schedulers,
} from '../scheduler/index.js'
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
    .description('run night-shift every night on this machine or in GitHub Actions')

  schedule
    .command('install')
    .description('start `nightshift run` when a window opens; it starts no unit after it closes')
    .option(
      '--with <scheduler>',
      `${[...Object.keys(localSchedulers()), GITHUB_ACTIONS].join(', ')} (default: launchd on macOS, else systemd if it runs, else cron)`,
    )
    .action((opts: { with?: string }) => installSchedule(program.opts().config, opts.with))

  schedule
    .command('remove')
    .description(`remove the nightly job, and ${WORKFLOW} in the current repo`)
    .action(async () => {
      const removed = []
      for (const scheduler of Object.values(localSchedulers()))
        if (await scheduler.remove()) removed.push(scheduler.id)
      const root = await gitRoot()
      if (root && (await removeWorkflow(root))) removed.push(GITHUB_ACTIONS)
      console.log(
        removed.length ? `Removed the ${removed.join(', ')} job` : 'No nightly job installed',
      )
    })

  schedule
    .command('status')
    .description('show the installed nightly job')
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
      if (root && existsSync(join(root, WORKFLOW))) {
        found = true
        console.log(`Scheduled with ${GITHUB_ACTIONS}: ${join(root, WORKFLOW)}`)
      }
      if (!found) console.log('No nightly job installed')
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
        `the ${scheduler.id} job starts at ${describeStarts(job.starts)}, the config's windows start at ${describeStarts(wanted)}; run \`nightshift schedule install\``,
      )
  }
  return warnings
}

export const gitRoot = (run: Exec = exec) =>
  run('git', ['rev-parse', '--show-toplevel']).catch(() => undefined)

/** Installs the nightly job with the named scheduler, or the platform's default. */
export async function installSchedule(config: string | undefined, id?: string): Promise<void> {
  if (id === GITHUB_ACTIONS) return installWorkflow(config)
  const all = localSchedulers()
  const scheduler = all[id ?? defaultScheduler()]
  if (!scheduler) {
    console.error(
      `unknown scheduler "${id}"; use ${[...Object.keys(all), GITHUB_ACTIONS].join(', ')}`,
    )
    process.exitCode = 1
    return
  }
  try {
    const path = resolve(configPath(config))
    const windows = windowsOf(await loadConfig(path))
    const bin = realpathSync(process.argv[1] ?? '')
    const log = join(stateDir, 'schedule.log')
    await mkdir(stateDir, { recursive: true })
    for (const other of Object.values(all))
      if (other !== scheduler && (await other.remove())) console.log(`Removed the ${other.id} job`)
    const where = await scheduler.install({
      command: [process.execPath, bin, 'run', '--scheduled', '--config', path],
      starts: startsOf(windows),
      path: process.env.PATH ?? '',
      log,
    })
    console.log(
      `Scheduled with ${scheduler.id} for ${windows.map(describeWindow).join(', ')}: ${where}`,
    )
    console.log(`Log: ${log}. The job keeps this shell's PATH; secrets come from the env file.`)
    if (scheduler.id === 'systemd')
      console.log(
        'User timers run only while you are logged in; `loginctl enable-linger` lifts that.',
      )
  } catch (e) {
    reportConfigError(e)
  }
}

/** What install reaches outside the repo's files; injected so tests fake it. */
export interface Io {
  run: Exec
  ask: Ask
  env: NodeJS.ProcessEnv
  setSecret: (name: string, value: string) => Promise<void>
}

/** Sets a repository secret of the current repo; the value goes through stdin, never argv. */
const ghSecretSet = async (name: string, value: string) =>
  void (await execa('gh', ['secret', 'set', name], { input: value }))

const terminal: Io = { run: exec, ask: terminalAsk, env: process.env, setSecret: ghSecretSet }

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
    const {
      night,
      windows,
      providers: picked,
      sources: configured,
      notify,
      after_unit,
      repos,
      mcp,
    } = await loadConfig(path)
    const used = picked.flatMap((p) => providers[p.id] ?? [])
    const secrets = new Set([
      'GH_TOKEN',
      ...used.flatMap((p) => p.secrets),
      ...Object.entries(configured).flatMap(([id, cfg]) => sourceFor(id, cfg)?.secrets(cfg) ?? []),
      ...(notify?.secrets ?? []),
      ...(after_unit?.secrets ?? []),
      ...Object.values(repos).flatMap((r) => r.secrets),
      ...Object.values(mcp).flatMap((s) => s.secrets),
    ])
    const text = workflow({
      starts: startsOf(windowsOf({ night, windows })),
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      config: REPO_CONFIG,
      version: packageVersion,
      packages: used.map((p) => p.package),
      secrets: [...secrets],
      setup: Object.values(configured).flatMap((cfg) =>
        isCommand(cfg) && cfg.setup ? [cfg.setup] : [],
      ),
    })
    const changed = []
    if (await sync(root, WORKFLOW, io.ask, (staged) => writeFile(staged, text))) {
      console.log(`Wrote ${WORKFLOW}`)
      changed.push(WORKFLOW)
    }
    if (await syncCopy(path, root, REPO_CONFIG, io.ask)) changed.push(REPO_CONFIG)
    const skills = skillsDirOf(path)
    if (
      (await readdir(skills).catch(() => [])).length &&
      (await syncCopy(skills, root, REPO_SKILLS, io.ask))
    )
      changed.push(REPO_SKILLS)
    const unset = await offerSecrets([...secrets], io.env, io.ask, io.setSecret).catch((e) => {
      if (e instanceof Cancelled) return [...secrets]
      throw e
    })
    if (changed.length || unset.length) console.log('Before the first night:')
    if (changed.length) console.log(`  commit ${and(changed)}`)
    if (unset.length) console.log(`  add these repository secrets: ${unset.join(', ')}`)
    if (unset.includes('GH_TOKEN')) console.log(`  ${GH_TOKEN_HELP}`)
  } catch (e) {
    if (!(e instanceof Cancelled)) return reportConfigError(e)
    console.error('Cancelled')
    process.exitCode = 1
  }
}

const and = (names: string[]) =>
  [names.slice(0, -1).join(', '), names.at(-1)].filter(Boolean).join(' and ')

/**
 * Copies `from`, a file or a folder replaced as a whole, to `to` under the repo root; when the
 * repo's copy differs, only after showing the diff and asking. True when it copied.
 */
export async function syncCopy(from: string, root: string, to: string, ask: Ask): Promise<boolean> {
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
  ask: Ask,
  stage: (staged: string) => Promise<void>,
): Promise<boolean> {
  const tmp = await mkdtemp(join(tmpdir(), 'nightshift-'))
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
      if (diff.exitCode !== 1) throw new Error(diff.stderr)
      console.log(diff.stdout)
      const question = statSync(staged).isDirectory()
        ? `Replace all of ${to} with the changes above, deleting anything only the repo's copy has?`
        : `Overwrite ${to} with the changes above?`
      if (!(await ask.confirm(question))) {
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
  set: (name: string, value: string) => Promise<void>,
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
