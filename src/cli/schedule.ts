import { existsSync, realpathSync } from 'node:fs'
import { copyFile, mkdir, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import type { Command } from 'commander'
import { execa } from 'execa'
import { configPath, loadConfig } from '../config/load.js'
import { stateDir } from '../config/paths.js'
import type { Ask } from '../core/types.js'
import { clock } from '../core/window.js'
import { exec } from '../forge/gh.js'
import { providers } from '../providers/index.js'
import { REPO_CONFIG, removeWorkflow, WORKFLOW, workflow } from '../scheduler/github-actions.js'
import { defaultScheduler, schedulers } from '../scheduler/index.js'
import { sources } from '../sources/index.js'
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
    .description('start `nightshift run` at night.start; it starts no unit after night.end')
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
        const at = [job.hour, job.minute].map((n) => String(n).padStart(2, '0')).join(':')
        const flag = job.command.indexOf('--config')
        const config = flag >= 0 ? job.command[flag + 1] : 'the default'
        console.log(`Scheduled with ${scheduler.id} at ${at}`)
        console.log(`Config: ${config}`)
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
const gitRoot = () => exec('git', ['rev-parse', '--show-toplevel']).catch(() => undefined)

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
    const { night } = await loadConfig(path)
    const [hour, minute] = clock(night.start)
    const bin = realpathSync(process.argv[1] ?? '')
    const log = join(stateDir, 'schedule.log')
    await mkdir(stateDir, { recursive: true })
    for (const other of Object.values(all))
      if (other !== scheduler && (await other.remove())) console.log(`Removed the ${other.id} job`)
    const where = await scheduler.install({
      command: [process.execPath, bin, 'run', '--scheduled', '--config', path],
      hour,
      minute,
      path: process.env.PATH ?? '',
      log,
    })
    console.log(
      `Scheduled with ${scheduler.id} at ${night.start}, window until ${night.end}: ${where}`,
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

async function installWorkflow(config: string | undefined): Promise<void> {
  const root = await gitRoot()
  if (!root) {
    console.error('GitHub Actions runs from a repo; run this inside a git repository')
    process.exitCode = 1
    return
  }
  const file = join(root, WORKFLOW)
  if (existsSync(file)) {
    console.error(`${WORKFLOW} already exists; \`nightshift schedule remove\` deletes it`)
    process.exitCode = 1
    return
  }
  try {
    const path = configPath(config)
    const { night, providers: picked, sources: configured, notify } = await loadConfig(path)
    const used = picked.flatMap((p) => providers[p.id] ?? [])
    const secrets = new Set([
      'GH_TOKEN',
      ...used.flatMap((p) => p.secrets),
      ...Object.entries(configured).flatMap(([id, cfg]) => sources[id]?.secrets(cfg) ?? []),
      ...(notify?.secrets ?? []),
    ])
    await mkdir(dirname(file), { recursive: true })
    await writeFile(
      file,
      workflow({
        start: night.start,
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        config: REPO_CONFIG,
        packages: used.map((p) => p.package),
        secrets: [...secrets],
      }),
    )
    console.log(`Wrote ${WORKFLOW}`)
    const repoConfig = join(root, REPO_CONFIG)
    if (existsSync(repoConfig)) console.log(`Kept the existing ${REPO_CONFIG}`)
    else {
      await mkdir(dirname(repoConfig), { recursive: true })
      await copyFile(path, repoConfig)
      console.log(`Copied ${path} to ${REPO_CONFIG}`)
    }
    const unset = await offerSecrets([...secrets], process.env, terminalAsk, ghSecretSet).catch(
      (e) => {
        if (e instanceof Cancelled) return [...secrets]
        throw e
      },
    )
    console.log('Before the first night:')
    console.log(`  commit ${WORKFLOW} and ${REPO_CONFIG}`)
    if (unset.length) console.log(`  add these repository secrets: ${unset.join(', ')}`)
    if (unset.includes('GH_TOKEN')) console.log(`  ${GH_TOKEN_HELP}`)
  } catch (e) {
    reportConfigError(e)
  }
}

/** Sets a repository secret of the current repo; the value goes through stdin, never argv. */
const ghSecretSet = async (name: string, value: string) =>
  void (await execa('gh', ['secret', 'set', name], { input: value }))

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
