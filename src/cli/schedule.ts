import { existsSync, realpathSync, statSync } from 'node:fs'
import { cp, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import type { Command } from 'commander'
import { execa } from 'execa'
import { ConfigError, configPath, loadConfig } from '../config/load.js'
import { bin, packageVersion, skillsDirOf, stateDir } from '../config/paths.js'
import type { Config } from '../config/schema.js'
import { hasSkills } from '../config/skills.js'
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
  if (hasEnvironment(text))
    return console.log(
      `The environment ${person} and its secrets stay; \`gh api -X DELETE repos/{owner}/{repo}/environments/${person}\` deletes them`,
    )
  const suffixed = [
    ...new Set(text.match(new RegExp(`\\w+${suffixOf(person)}(?=\\s*}})`, 'g')) ?? []),
  ]
  console.log(
    `Its suffixed repository secrets stay, readable from any branch: ${suffixed.map((name) => `\`gh secret delete ${name}\``).join(', ')}`,
  )
}

const hasEnvironment = (workflow: string) => /^\s+environment:/m.test(workflow)

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

/**
 * Writes the workflow and copies the config and skills into the repo, with `person` theirs in a
 * shared control repo; run again, it syncs them.
 */
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
  if (!person && (await isShared(root))) {
    const login = await io.run('gh', ['api', 'user', '--jq', '.login']).catch(() => '')
    console.error(
      `This is a shared control repo, with a workflow per person; run \`nightshift schedule install --with ${GITHUB_ACTIONS} --as ${login.toLowerCase() || '<name>'}\``,
    )
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
    const text = workflow({ ...base, config: REPO_CONFIG, secrets })
    const changed = await syncRepo(root, WORKFLOW, text, path, REPO_CONFIG, io.ask)
    const unset = await offerSecrets(secrets, io.env, io.ask, io.setSecret).catch((e) => {
      if (e instanceof Cancelled) return secrets
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

/** Whether the repo holds a person's workflow or config, as a shared control repo does. */
async function isShared(root: string): Promise<boolean> {
  const people = await readdir(join(root, dirname(REPO_CONFIG))).catch(() => [])
  return (
    (await workflows(root)).some((file) => file !== join(root, WORKFLOW)) ||
    people.some((name) => existsSync(join(root, configOf(name))))
  )
}

async function installForPerson(
  root: string,
  path: string,
  person: string,
  base: Omit<Workflow, 'config' | 'secrets' | 'person'>,
  { personal, shared }: { personal: string[]; shared: string[] },
  io: Io,
): Promise<void> {
  const file = workflowOf(person)
  const current = await readFile(join(root, file), 'utf8').catch(() => '')
  const environment = await environmentFor(io, person, current)
  if (environment === undefined) {
    process.exitCode = 1
    return
  }
  const config = configOf(person)
  const text = workflow({
    ...base,
    config,
    secrets: [...personal, ...shared],
    person: { name: person, personal, environment },
  })
  const changed = await syncRepo(root, file, text, path, config, io.ask)

  const suffixed = (name: string) => name + suffixOf(person)
  const listed = await repoSecrets(io.run, (list, e) =>
    console.log(
      list === 'repo'
        ? `Couldn't list the repo's secrets (${reasonOf(e)}), so every shared one is offered`
        : `Couldn't list the organization's secrets (${reasonOf(e)}), so one set there is offered anyway`,
    ),
  )
  const existing = new Set([...listed.repo, ...listed.org])
  const present = shared.filter((name) => existing.has(name))
  if (present.length)
    console.log(`Already repository or organization secrets: ${present.join(', ')}`)
  const leftovers = personal.map(suffixed).filter((name) => listed.repo.has(name))
  if (environment && leftovers.length)
    console.log(
      `Warning: ${leftovers.join(', ')} are still repository secrets, readable from any branch, and fill in for any that environment ${person} lacks. Once it has its own, delete them: ${leftovers.map((name) => `\`gh secret delete ${name}\``).join(', ')}`,
    )
  const own: Layer = environment
    ? {
        label: (name) => `${suffixed(name)} in environment ${person}`,
        args: (name) => [suffixed(name), '--env', person],
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
  if (changed.length || unsetPersonal.length || unsetShared.length)
    console.log('Before the first night:')
  if (changed.length) console.log(`  commit ${and(changed)}`)
  if (unsetPersonal.length)
    console.log(
      environment
        ? `  add these secrets to environment ${person}: ${unsetPersonal.map(suffixed).join(', ')}`
        : `  add these suffixed repository secrets: ${unsetPersonal.map(suffixed).join(', ')}`,
    )
  if (unsetShared.length) console.log(`  add these repository secrets: ${unsetShared.join(', ')}`)
  if (unsetPersonal.includes('GH_TOKEN')) console.log(`  ${GH_TOKEN_HELP}`)
}

/**
 * Whether the person's secrets live in their environment: true once it is there, false when
 * GitHub refuses it and the person takes the fallback, undefined to stop.
 */
async function environmentFor(
  io: Io,
  person: string,
  current: string,
): Promise<boolean | undefined> {
  try {
    await ensureEnvironment(io.run, person)
    return true
  } catch (e) {
    if (!refused(e)) {
      console.error(`Couldn't set up the environment ${person}: ${reasonOf(e)}`)
      return undefined
    }
    if (hasEnvironment(current)) {
      console.error(
        `${workflowOf(person)} uses the environment ${person}, which GitHub now refuses: ${reasonOf(e)}. Changed nothing`,
      )
      return undefined
    }
    console.log(`GitHub refuses the environment ${person}: ${reasonOf(e)}`)
    const fallback = await io.ask.confirm(
      `Store ${person}'s secrets as repository secrets ending in ${suffixOf(person)}, which any branch's workflow can read?`,
      false,
    )
    if (fallback) return false
    console.error('Changed nothing')
    return undefined
  }
}

/**
 * Keeps the person's environment as it is, or creates it deployable from the default branch
 * only. Throws gh's error when GitHub refuses it; a failure once it exists is no refusal.
 */
async function ensureEnvironment(run: Exec, person: string): Promise<void> {
  const environment = `repos/{owner}/{repo}/environments/${person}`
  const policy = await run('gh', ['api', environment, '--jq', '.deployment_branch_policy']).catch(
    (e) => {
      if (statusOf(e) !== '404') throw e
    },
  )
  const policies = `${environment}/deployment-branch-policies`
  if (policy !== undefined) {
    console.log(`Kept the environment ${person}`)
    if (policy === 'null')
      console.log(
        `Warning: any branch can deploy to environment ${person}, so any branch's workflow can read its secrets; limit it to the default branch in the repo's Settings > Environments > ${person}`,
      )
    else if (JSON.parse(policy).custom_branch_policies)
      await defaultBranchIn(run, policies).then(
        ({ branch, names }) => {
          // A pattern may cover the default branch; matching GitHub's globs isn't worth a warning.
          if (!names.includes(branch) && !names.some((name) => name.includes('*')))
            console.log(
              `Warning: environment ${person}'s branch policies don't name the default branch, so ${person}'s job can't use it; add it in the repo's Settings > Environments > ${person}`,
            )
        },
        (e) =>
          console.log(`Couldn't check environment ${person}'s branch policies: ${reasonOf(e)}`),
      )
    return
  }
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
  try {
    const { branch, names } = await defaultBranchIn(run, policies)
    if (!names.includes(branch))
      await run('gh', ['api', '-X', 'POST', policies, '-f', `name=${branch}`])
  } catch (e) {
    throw new Error(`it exists, but limiting it to the default branch failed: ${reasonOf(e)}`)
  }
  console.log(`Created the environment ${person}, deployable from the default branch only`)
}

/** The repo's default branch, and the names of an environment's branch policies. */
async function defaultBranchIn(
  run: Exec,
  policies: string,
): Promise<{ branch: string; names: string[] }> {
  const branch = await run('gh', [
    'repo',
    'view',
    '--json',
    'defaultBranchRef',
    '--jq',
    '.defaultBranchRef.name',
  ])
  const names = await run('gh', ['api', '--paginate', policies, '--jq', '.branch_policies[].name'])
  return { branch, names: names.split('\n') }
}

/** The HTTP status gh reports for a failed call, e.g. "403". */
const statusOf = (e: unknown) =>
  /\(HTTP (\d+)\)/.exec(String((e as { stderr?: string }).stderr ?? ''))?.[1]

/** GitHub saying no, rather than a network error or a gh that isn't logged in. */
const refused = (e: unknown) => ['403', '404', '422'].includes(statusOf(e) ?? '')

/** gh's own last line of a failed call, e.g. "gh: Must have admin rights to Repository. (HTTP 403)". */
const reasonOf = (e: unknown) =>
  (
    String((e as { stderr?: string }).stderr ?? '').trim() ||
    (e instanceof Error ? e.message : String(e))
  )
    .split('\n')
    .at(-1)

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

/** Lists the current repo's secrets and its org's; a list gh can't get is empty, after `failed` hears why. */
export async function repoSecrets(
  run: Exec,
  failed: (list: 'repo' | 'org', e: unknown) => void,
): Promise<RepoSecrets> {
  const repo = await secretNames(run).catch((e) => {
    failed('repo', e)
    return new Set<string>()
  })
  const { owner, org } = await orgSecrets(run).catch((e) => {
    failed('org', e)
    return { owner: '', org: new Set<string>() }
  })
  return { owner, repo, org }
}

/** The repo owner's login and, for an org, its secrets shared with the repo; throws when gh can't. */
async function orgSecrets(run: Exec): Promise<{ owner: string; org: Set<string> }> {
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
  return { owner: owner.login, org }
}

/** Syncs the workflow, then the config and the user's skills beside it; returns what it wrote. */
async function syncRepo(
  root: string,
  file: string,
  text: string,
  path: string,
  config: string,
  ask: Ask,
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
      if (diff.exitCode !== 1) throw new ConfigError(to, [`git diff failed: ${diff.stderr.trim()}`])
      console.log(diff.stdout)
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
