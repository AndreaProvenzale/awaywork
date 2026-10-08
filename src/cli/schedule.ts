import { existsSync, realpathSync } from 'node:fs'
import { copyFile, cp, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import type { Command } from 'commander'
import { execa } from 'execa'
import { configPath, loadConfig } from '../config/load.js'
import { bin, packageVersion, skillsDirOf, stateDir } from '../config/paths.js'
import type { Config } from '../config/schema.js'
import type { Ask } from '../core/types.js'
import { describeWindow, startsOf, type Window, windowsOf } from '../core/window.js'
import { type Exec, exec } from '../forge/gh.js'
import { providers } from '../providers/index.js'
import {
  configOf,
  REPO_CONFIG,
  removeWorkflow,
  suffixOf,
  WORKFLOW,
  type Workflow,
  workflow,
  workflowOf,
  workflows,
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
    .option(
      '--as <person>',
      `with ${GITHUB_ACTIONS}: install for one person of a shared control repo`,
    )
    .action((opts: { with?: string; as?: string }) =>
      installSchedule(program.opts().config, opts.with, opts.as),
    )

  schedule
    .command('remove')
    .description(`remove the nightly job, and ${WORKFLOW} in the current repo`)
    .option('--as <person>', "remove only that person's workflow from the current repo")
    .action(async (opts: { as?: string }) => {
      if (opts.as !== undefined) return removePersonWorkflow(opts.as)
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
      for (const file of root ? await workflows(root) : []) {
        found = true
        console.log(`Scheduled with ${GITHUB_ACTIONS}: ${file}`)
      }
      if (!found) console.log('No nightly job installed')
    })
}

/** Deletes a person's workflow; their environment, or suffixed repository secrets, and their values stay. */
export async function removePersonWorkflow(person: string, run: Exec = exec): Promise<void> {
  const root = await gitRoot(run)
  const file = workflowOf(person)
  const text =
    root && PERSON.test(person) && (await readFile(join(root, file), 'utf8').catch(() => ''))
  if (!root || !text || !(await removeWorkflow(root, person))) {
    console.log(`No ${file} in this repo`)
    return
  }
  console.log(`Removed ${file}`)
  const suffixed = [
    ...new Set(text.match(new RegExp(`\\w+${suffixOf(person)}(?=\\s*}})`, 'g')) ?? []),
  ]
  if (suffixed.length)
    console.log(
      `Its suffixed repository secrets stay, readable from any branch: ${suffixed.map((name) => `\`gh secret delete ${name}\``).join(', ')}`,
    )
  else
    console.log(
      `The environment ${person} and its secrets stay; \`gh api -X DELETE repos/{owner}/{repo}/environments/${person}\` deletes them`,
    )
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
export async function installSchedule(
  config: string | undefined,
  id?: string,
  person?: string,
): Promise<void> {
  if (id === GITHUB_ACTIONS) return installWorkflow(config, person)
  if (person !== undefined) {
    console.error(`--as goes with --with ${GITHUB_ACTIONS}`)
    process.exitCode = 1
    return
  }
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

/** What install reaches outside the repo's files; injected so tests replay gh. */
export interface Io {
  run: Exec
  ask: Ask
  env: NodeJS.ProcessEnv
  /** Runs `gh secret set` with these args, the value on stdin. */
  setSecret: (args: string[], value: string) => Promise<void>
}

/** Sets a secret of the current repo; the value goes through stdin, never argv. */
const ghSecretSet = async (args: string[], value: string) =>
  void (await execa('gh', ['secret', 'set', ...args], { input: value }))

const terminal: Io = { run: exec, ask: terminalAsk, env: process.env, setSecret: ghSecretSet }

const PERSON = /^[a-z0-9][a-z0-9-]*$/

/** The secrets a config needs on a runner: its user's own, and those a team can share. A name in both is personal. */
export function secretsOf(config: Config): { personal: string[]; shared: string[] } {
  const personal = new Set([
    'GH_TOKEN',
    ...config.providers.flatMap((p) => providers[p.id]?.secrets ?? []),
    ...Object.entries(config.sources).flatMap(
      ([id, cfg]) => sourceFor(id, cfg)?.secrets(cfg) ?? [],
    ),
  ])
  const shared = new Set(
    [
      ...(config.notify?.secrets ?? []),
      ...(config.after_unit?.secrets ?? []),
      ...Object.values(config.repos).flatMap((r) => r.secrets),
      ...Object.values(config.mcp).flatMap((s) => s.secrets),
    ].filter((name) => !personal.has(name)),
  )
  return { personal: [...personal], shared: [...shared] }
}

/** Writes the workflow and the repo's copy of the config; with `person`, theirs in a shared control repo. */
export async function installWorkflow(
  config: string | undefined,
  person?: string,
  io: Io = terminal,
): Promise<void> {
  if (person !== undefined && !PERSON.test(person)) {
    console.error(
      `--as takes lowercase letters, digits and -, starting with a letter or digit, not "${person}"`,
    )
    process.exitCode = 1
    return
  }
  const root = await gitRoot(io.run)
  if (!root) {
    console.error('GitHub Actions runs from a repo; run this inside a git repository')
    process.exitCode = 1
    return
  }
  const file = join(root, WORKFLOW)
  if (!person && existsSync(file)) {
    console.error(`${WORKFLOW} already exists; \`nightshift schedule remove\` deletes it`)
    process.exitCode = 1
    return
  }
  try {
    const path = configPath(config)
    const loaded = await loadConfig(path)
    const used = loaded.providers.flatMap((p) => providers[p.id] ?? [])
    const base = {
      starts: startsOf(windowsOf(loaded)),
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      version: packageVersion,
      packages: used.map((p) => p.package),
      setup: Object.values(loaded.sources).flatMap((cfg) =>
        isCommand(cfg) && cfg.setup ? [cfg.setup] : [],
      ),
    }
    const { personal, shared } = secretsOf(loaded)
    if (person) return await installForPerson(root, path, person, base, { personal, shared }, io)
    const secrets = [...personal, ...shared]
    await mkdir(dirname(file), { recursive: true })
    await writeFile(file, workflow({ ...base, config: REPO_CONFIG, secrets }))
    console.log(`Wrote ${WORKFLOW}`)
    const repoConfig = join(root, REPO_CONFIG)
    if (existsSync(repoConfig)) console.log(`Kept the existing ${REPO_CONFIG}`)
    else {
      await mkdir(dirname(repoConfig), { recursive: true })
      await copyFile(path, repoConfig)
      console.log(`Copied ${path} to ${REPO_CONFIG}`)
    }
    const skills = await copySkillsToRepo(skillsDirOf(path), root)
    if (skills === 'kept') console.log(`Kept the existing ${REPO_SKILLS}`)
    if (skills === 'copied') console.log(`Copied ${skillsDirOf(path)} to ${REPO_SKILLS}`)
    const unset = await offerSecrets(secrets, io.env, io.ask, io.setSecret).catch((e) => {
      if (e instanceof Cancelled) return secrets
      throw e
    })
    console.log('Before the first night:')
    const commit = [WORKFLOW, REPO_CONFIG, ...(skills === 'copied' ? [REPO_SKILLS] : [])]
    console.log(`  commit ${commit.slice(0, -1).join(', ')} and ${commit.at(-1)}`)
    if (unset.length) console.log(`  add these repository secrets: ${unset.join(', ')}`)
    if (unset.includes('GH_TOKEN')) console.log(`  ${GH_TOKEN_HELP}`)
  } catch (e) {
    if (!(e instanceof Cancelled)) return reportConfigError(e)
    console.error('Cancelled')
    process.exitCode = 1
  }
}

async function installForPerson(
  root: string,
  path: string,
  person: string,
  base: Omit<Workflow, 'config' | 'secrets' | 'person'>,
  { personal, shared }: { personal: string[]; shared: string[] },
  io: Io,
): Promise<void> {
  const environment = await createEnvironment(io.run, person).then(
    () => true,
    (e) => {
      console.log(`Couldn't create the environment ${person}: ${reasonOf(e)}`)
      console.log(
        `So ${person}'s secrets are repository secrets ending in ${suffixOf(person)}, with no branch limit: any branch's workflow can read every teammate's token`,
      )
      return false
    },
  )
  const file = workflowOf(person)
  const config = configOf(person)
  await mkdir(dirname(join(root, file)), { recursive: true })
  await writeFile(
    join(root, file),
    workflow({
      ...base,
      config,
      secrets: [...personal, ...shared],
      person: { name: person, suffixed: environment ? undefined : personal },
    }),
  )
  console.log(`Wrote ${file}`)
  await syncCopy(path, root, config, io.ask)
  const skills = skillsDirOf(path)
  if ((await readdir(skills).catch(() => [])).length)
    await syncCopy(skills, root, skillsDirOf(config), io.ask)

  const suffixed = (name: string) => name + suffixOf(person)
  const listed = await repoSecrets(io.run).catch(() => ({
    owner: '',
    repo: new Set<string>(),
    org: new Set<string>(),
  }))
  const existing = new Set([...listed.repo, ...listed.org])
  const present = shared.filter((name) => existing.has(name))
  if (present.length)
    console.log(`Already repository or organization secrets: ${present.join(', ')}`)
  const standIns = personal.filter((name) => existing.has(name))
  if (environment && standIns.length)
    console.log(`Warning: ${standInWarning(person, standIns, listed)}`)
  const own: Layer = environment
    ? {
        label: (name) => `${name} in environment ${person}`,
        args: (name) => [name, '--env', person],
      }
    : {
        label: (name) => `the ${suffixed(name)} repository secret`,
        args: (name) => [suffixed(name)],
      }
  const team: Layer = {
    label: (name) => `the ${name} repository secret, shared with the team,`,
    args: (name) => [name],
  }
  let unsetPersonal = personal
  let unsetShared = shared.filter((name) => !existing.has(name))
  try {
    unsetPersonal = await offerSecrets(personal, io.env, io.ask, io.setSecret, own)
    unsetShared = await offerSecrets(unsetShared, io.env, io.ask, io.setSecret, team)
  } catch (e) {
    if (!(e instanceof Cancelled)) throw e
  }
  console.log('Before the first night:')
  console.log(`  commit ${file} and ${dirname(config)}/`)
  if (unsetPersonal.length)
    console.log(
      environment
        ? `  add these secrets to environment ${person}: ${unsetPersonal.join(', ')}`
        : `  add these suffixed repository secrets: ${unsetPersonal.map(suffixed).join(', ')}`,
    )
  if (unsetShared.length) console.log(`  add these repository secrets: ${unsetShared.join(', ')}`)
  if (unsetPersonal.includes('GH_TOKEN')) console.log(`  ${GH_TOKEN_HELP}`)
}

/** Creates the person's environment, deployable from the default branch only; throws when GitHub refuses. */
async function createEnvironment(run: Exec, person: string): Promise<void> {
  const environment = `repos/{owner}/{repo}/environments/${person}`
  await run('gh', [
    'api',
    '-X',
    'PUT',
    environment,
    '-F',
    'deployment_branch_policy[protected_branches]=false',
    '-F',
    'deployment_branch_policy[custom_branch_policies]=true',
  ])
  const branch = await run('gh', [
    'repo',
    'view',
    '--json',
    'defaultBranchRef',
    '--jq',
    '.defaultBranchRef.name',
  ])
  const policies = `${environment}/deployment-branch-policies`
  const allowed = await run('gh', [
    'api',
    '--paginate',
    policies,
    '--jq',
    '.branch_policies[].name',
  ])
  if (!allowed.split('\n').includes(branch))
    await run('gh', ['api', '-X', 'POST', policies, '-f', `name=${branch}`])
}

/** gh's own last line of a failed call, e.g. "gh: Must have admin rights to Repository. (HTTP 403)". */
export const reasonOf = (e: unknown) =>
  (String((e as { stderr?: string }).stderr ?? '').trim() || String(e)).split('\n').at(-1)

/** The secrets every workflow of the current repo reads besides an environment's. */
export interface RepoSecrets {
  owner: string
  repo: Set<string>
  /** The org's secrets shared with the repo. */
  org: Set<string>
}

const ghNames = async (run: Exec, args: string[]) =>
  new Set((await run('gh', args)).split('\n').filter(Boolean))

/** The names of the current repo's secrets, or of one environment's; throws when gh can't list them. */
export const secretNames = (run: Exec, environment?: string) =>
  ghNames(run, [
    'secret',
    'list',
    ...(environment ? ['--env', environment] : []),
    '--json',
    'name',
    '--jq',
    '.[].name',
  ])

/** Lists the current repo's secrets and its org's; throws when gh can't. */
export async function repoSecrets(run: Exec): Promise<RepoSecrets> {
  const owner = JSON.parse(
    await run('gh', ['api', 'repos/{owner}/{repo}', '--jq', '.owner | {login, type}']),
  )
  // Only an org-owned repo has org secrets; listing a user's fails.
  const org =
    owner.type === 'Organization'
      ? await ghNames(run, [
          'api',
          '--paginate',
          'repos/{owner}/{repo}/actions/organization-secrets',
          '--jq',
          '.secrets[].name',
        ])
      : new Set<string>()
  return { owner: owner.login, repo: await secretNames(run), org }
}

/** Why these personal names, set at repo or org level, put someone else's values in a person's job. */
export function standInWarning(person: string, names: string[], at: RepoSecrets): string {
  const deletions = [
    ...names.filter((name) => at.repo.has(name)).map((name) => `\`gh secret delete ${name}\``),
    ...names
      .filter((name) => at.org.has(name))
      .map(
        (name) =>
          `\`gh secret delete ${name} --org ${at.owner}\` (an org secret, or in the org's settings)`,
      ),
  ]
  return `${names.join(', ')} already exist at repo or org level and stand in for any that environment ${person} lacks, so ${person}'s job would run with someone else's. Set them in the environment, and once each person has their own, delete the shared ones: ${deletions.join(', ')}`
}

/**
 * Copies `from`, a file or a folder replaced as a whole, to `to` under the repo root; when the
 * repo's copy differs, only after showing the diff and asking.
 */
export async function syncCopy(from: string, root: string, to: string, ask: Ask): Promise<void> {
  const tmp = await mkdtemp(join(tmpdir(), 'nightshift-'))
  try {
    const staged = join(tmp, basename(to))
    // A linked skill is committed as its files, not as a link to this machine.
    await cp(from, staged, { recursive: true, dereference: true })
    const target = join(root, to)
    if (existsSync(target)) {
      const diff = await execa(bin('git'), ['diff', '--no-index', '--', target, staged], {
        reject: false,
      })
      if (diff.exitCode === 0) return console.log(`${to} is up to date`)
      if (diff.exitCode !== 1) throw new Error(diff.stderr)
      console.log(diff.stdout)
      if (!(await ask.confirm(`Overwrite ${to} with the changes above?`)))
        return console.log(`Kept ${to}`)
      await rm(target, { recursive: true })
    }
    await mkdir(dirname(target), { recursive: true })
    await cp(staged, target, { recursive: true })
    console.log(`Copied ${from} to ${to}`)
  } finally {
    await rm(tmp, { recursive: true })
  }
}

const REPO_SKILLS = skillsDirOf(REPO_CONFIG)

/** Copies the user's skills, if any, beside the repo's config, unless the repo has its own there. */
export async function copySkillsToRepo(
  skills: string,
  root: string,
): Promise<'copied' | 'kept' | undefined> {
  if ((await readdir(skills).catch(() => [])).length === 0) return undefined
  const to = join(root, REPO_SKILLS)
  if (existsSync(to)) return 'kept'
  // A linked skill is committed as its files, not as a link to this machine.
  await cp(skills, to, { recursive: true, dereference: true })
  return 'copied'
}

/** Where `gh secret set` puts a secret, as a prompt names it and as its args. */
interface Layer {
  label: (name: string) => string
  args: (name: string) => string[]
}

const repository: Layer = {
  label: (name) => `the ${name} repository secret`,
  args: (name) => [name],
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
  layer: Layer = repository,
): Promise<string[]> {
  const unset = []
  for (const name of names) {
    const value = env[name]
    if (value && (await ask.confirm(`Set ${layer.label(name)} from your env?`))) {
      try {
        await set(layer.args(name), value)
        ask.note(`Set ${name}`)
        continue
      } catch {
        ask.note(`\`gh secret set ${layer.args(name).join(' ')}\` failed`)
      }
    }
    unset.push(name)
  }
  return unset
}
