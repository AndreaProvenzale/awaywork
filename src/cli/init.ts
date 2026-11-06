import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { parseEnv } from 'node:util'
import { cancel, confirm, intro, isCancel, log, outro, spinner } from '@clack/prompts'
import { type Command, InvalidArgumentError } from 'commander'
import { flow, queueYaml } from '../config/edit.js'
import { ConfigError, configPath, parseConfig } from '../config/load.js'
import { bin, builtinSkillsDir, envFile, pluginDir, skillsDirOf } from '../config/paths.js'
import { loadSkills } from '../config/skills.js'
import { defaultRules } from '../core/queue.js'
import type { SkillMeta } from '../core/skills.js'
import type { Ask, Ctx, Provider, Rule, Source } from '../core/types.js'
import { time } from '../core/window.js'
import { exec } from '../forge/gh.js'
import { providers } from '../providers/index.js'
import { sources } from '../sources/index.js'
import { Cancelled, defaultAsk } from './ask.js'
import { describeRule } from './format.js'

export function initCommand(program: Command): void {
  program
    .command('init')
    .description(
      "set awaywork up with Claude Code's /away, or write the detected defaults with --yes",
    )
    .option('-y, --yes', 'write the detected defaults, asking nothing; needs no terminal')
    .option('--provider <id...>', 'with --yes: providers, first takes units first')
    .option('--source <id...>', 'with --yes: sources to take work from')
    .option('--window <start-end>', 'with --yes: the run window, e.g. 01:00-07:00', parseWindow)
    .option('--force', 'with --yes: replace an existing config')
    .action(async (opts: InitOptions) => {
      const path = configPath(program.opts().config)
      if (!opts.yes) {
        if (!process.stdin.isTTY) {
          console.error(
            'init hands the setup to Claude Code in a terminal; without one, ask your agent to set awaywork up with /away (the awaywork plugin), pass --yes to take the detected defaults, or write the config by hand (`awaywork config schema` describes it) and run `awaywork doctor`',
          )
          process.exitCode = 1
          return
        }
        process.exitCode = await handOff(terminalHandoff, { path, exists: existsSync(path) })
        return
      }
      intro('awaywork init')
      try {
        if (existsSync(path) && !opts.force) {
          cancel(`${path} exists; --force replaces it`)
          process.exitCode = 1
          return
        }

        const found = process.stdout.isTTY ? spinner() : undefined
        found?.start('Looking for agents and a gh login')
        const installed: string[] = []
        const lines: string[] = []
        for (const p of Object.values(providers)) {
          const d = await p.detect().catch(() => ({ installed: false, version: undefined }))
          if (d.installed) installed.push(p.id)
          lines.push(`${p.id}: ${d.installed ? (d.version ?? 'installed') : 'not found'}`)
        }
        const ghLogin = await exec('gh', ['auth', 'status']).then(
          () => true,
          () => false,
        )
        lines.push(`gh: ${ghLogin ? 'logged in' : 'not logged in (gh auth login)'}`)
        if (found) found.stop(lines.join(', '))
        else log.info(lines.join(', '))

        const skills = {
          ...(await loadSkills(builtinSkillsDir)),
          ...(await loadSkills(skillsDirOf(path))),
        }
        const ctx: Ctx = { env: process.env, log: (line) => log.warn(line) }
        const ask = defaultAsk(presets(opts), (line) => log.info(line))
        const text = await initConfig({ ask, ctx, installed, ghLogin, skills })
        parseConfig(text, path)
        await mkdir(dirname(path), { recursive: true })
        await writeFile(path, text)
        outro(`Wrote ${path}. Next: awaywork doctor, awaywork plan, awaywork schedule install`)
      } catch (e) {
        if (e instanceof Cancelled) {
          cancel(`Nothing written: ${e.message}`)
          process.exitCode = 1
        } else if (e instanceof ConfigError) {
          cancel(`Nothing written, the answers make an invalid config:\n${e.message}`)
          process.exitCode = 1
        } else throw e
      }
    })
}

const plugin = 'awaywork@awaywork'

/** What interactive init runs, apart for tests. */
export interface Handoff {
  /** The command's stdout; undefined when it fails or isn't installed. */
  output: (cmd: string, args: string[]) => Promise<string | undefined>
  /** Runs the command on this terminal and returns its exit code. */
  spawn: (cmd: string, args: string[], env?: Record<string, string>) => number
  /** undefined when cancelled. */
  confirm: (message: string) => Promise<boolean | undefined>
  print: (message: string) => void
}

const terminalHandoff: Handoff = {
  output: (cmd, args) => exec(cmd, args).catch(() => undefined),
  spawn: (cmd, args, env) =>
    spawnSync(bin(cmd), args, {
      stdio: 'inherit',
      env: { ...withoutEnvFile(process.env, envFileVars()), ...env },
    }).status ?? 1,
  confirm: async (message) => {
    const answer = await confirm({ message })
    return isCancel(answer) ? undefined : answer
  },
  print: (message) => log.info(message),
}

const envFileVars = () => (existsSync(envFile) ? parseEnv(readFileSync(envFile, 'utf8')) : {})

/** The environment without what the env file added but claude's own login, so the agent never holds awaywork's tokens. */
export function withoutEnvFile(
  env: NodeJS.ProcessEnv,
  added: Record<string, string | undefined>,
): NodeJS.ProcessEnv {
  return Object.fromEntries(
    Object.entries(env).filter(([k, v]) => k === 'CLAUDE_CODE_OAUTH_TOKEN' || added[k] !== v),
  )
}

/** Opens Claude Code on `/away`, offering to install its plugin first; returns the exit code. */
export async function handOff(
  io: Handoff,
  config: { path: string; exists: boolean },
): Promise<number> {
  if ((await io.output('claude', ['--version'])) === undefined) {
    io.print(
      [
        "Claude Code isn't installed, so there's no /away to hand the setup to. Instead:",
        `- Codex: codex plugin marketplace add AndreaProvenzale/awaywork, codex plugin add ${plugin}, then ask it to set awaywork up with the awaywork:away skill`,
        `- another agent: load the skills in ${join(pluginDir, 'skills')}, https://andreaprovenzale.github.io/awaywork/guide/agents#codex-and-friends`,
        '- no agent: awaywork init --yes writes the detected defaults',
      ].join('\n'),
    )
    return 0
  }
  const listed = async () =>
    parsed<{ id: string; enabled: boolean; installPath?: string }>(
      await io.output('claude', ['plugin', 'list', '--json']),
    ).find((p) => p.id === plugin)
  let found = await listed()
  const args: string[] = []
  if (!found?.enabled) {
    const marketplace = parsed<{ name: string }>(
      await io.output('claude', ['plugin', 'marketplace', 'list', '--json']),
    ).some((m) => m.name === 'awaywork')
    const steps = [
      ...(marketplace
        ? [['plugin', 'marketplace', 'update', 'awaywork']]
        : found
          ? []
          : [['plugin', 'marketplace', 'add', 'AndreaProvenzale/awaywork']]),
      found ? ['plugin', 'enable', plugin] : ['plugin', 'install', plugin],
    ]
    const yes = await io.confirm(
      `${found ? 'Enable' : 'Install'} the awaywork plugin for Claude Code? It runs ${steps.map((s) => `claude ${s.join(' ')}`).join(', then ')}`,
    )
    if (yes === undefined) return 1
    if (!yes || !steps.every((step) => io.spawn('claude', step) === 0)) {
      args.push('--plugin-dir', pluginDir)
      io.print(
        `${yes ? 'That failed, so this' : 'This'} session loads the plugin from ${pluginDir}`,
      )
    } else found = await listed()
  }
  if (
    !args.length &&
    found?.installPath &&
    !existsSync(join(found.installPath, 'skills', 'setup'))
  ) {
    args.push('--plugin-dir', pluginDir)
    io.print(
      `Your awaywork plugin predates its setup skill, so this session loads the plugin from ${pluginDir}; claude plugin marketplace update awaywork, then claude plugin update ${plugin}, updates yours`,
    )
  }
  const request = config.exists
    ? '/away awaywork has a config already: show me where it stands and what I could change'
    : '/away set up awaywork'
  io.print(`Opening Claude Code on ${request}; /exit comes back here`)
  return io.spawn('claude', [...args, request], { AWAYWORK_CONFIG: resolve(config.path) })
}

function parsed<T>(json?: string): T[] {
  try {
    return JSON.parse(json ?? '[]')
  } catch {
    return []
  }
}

interface InitOptions {
  yes?: boolean
  provider?: string[]
  source?: string[]
  window?: [string, string]
  force?: boolean
}

function parseWindow(value: string): [string, string] {
  const [start = '', end = '', ...rest] = value.split('-')
  if (rest.length > 0 || !time.safeParse(start).success || !time.safeParse(end).success)
    throw new InvalidArgumentError('expected HH:MM-HH:MM, e.g. 01:00-07:00')
  return [start, end]
}

/** The --yes answers the flags give, keyed by the prompts of initConfig. */
function presets({ provider, source, window }: InitOptions): [RegExp, unknown][] {
  const presets: [RegExp, unknown][] = []
  if (provider) presets.push([/^Providers/, provider])
  if (source) presets.push([/^Where does the work come from/, source])
  if (window) presets.push([/^Window starts/, window[0]], [/^Window ends/, window[1]])
  return presets
}

export interface InitInput {
  ask: Ask
  ctx: Ctx
  installed: string[]
  ghLogin: boolean
  skills: Record<string, SkillMeta>
  providers?: Record<string, Provider>
  sources?: Record<string, Source>
}

/** Asks for providers, sources, a starting queue and the run window; returns the config text. */
export async function initConfig(input: InitInput): Promise<string> {
  const { ask, ctx, installed } = input
  const registry = { providers: input.providers ?? providers, sources: input.sources ?? sources }

  const ids = Object.keys(registry.providers)
  const keyless = (id: string) => id === 'cursor' && !ctx.env.CURSOR_API_KEY
  const hint = (id: string) =>
    !installed.includes(id) ? 'not installed' : keyless(id) ? 'needs CURSOR_API_KEY' : undefined
  let picked: string[] = []
  while (picked.length === 0)
    picked = await ask.multiselect(
      'Providers (pick at least one)',
      ids.map((id) => ({ value: id, hint: hint(id) })),
      ids.filter((id) => installed.includes(id) && !keyless(id)),
    )
  if (picked.length > 1) {
    const first = await ask.select(
      'Which provider takes units first? The next takes over when its quota runs out',
      picked.map((id) => ({ value: id })),
      picked[0],
    )
    picked = [first, ...picked.filter((id) => id !== first)]
  }

  const configs: Record<string, Record<string, unknown>> = {}
  const values: Record<string, Record<string, string[]>> = {}
  while (Object.keys(configs).length === 0) {
    const chosen = await ask.multiselect(
      'Where does the work come from? (pick at least one)',
      // Routines have nothing to ask: you write them in the config.
      Object.keys(registry.sources)
        .filter((id) => id !== 'routines')
        .map((id) => ({
          value: id,
          hint: id === 'github' && !input.ghLogin ? 'gh not logged in' : undefined,
        })),
      input.ghLogin ? ['github'] : [],
    )
    for (const id of chosen) {
      const source = registry.sources[id]
      try {
        const setup = (await source?.init?.(ask, ctx)) ?? { config: {} }
        configs[id] = setup.config
        values[id] = setup.values ?? {}
      } catch (e) {
        if (e instanceof Cancelled) throw e
        ask.note(`Skipping ${id}: ${(e as Error).message}`)
      }
    }
  }

  const defaults = defaultRules(Object.keys(configs))
  const kept = await ask.multiselect(
    'Starting queue, top rule first (reorder later with awaywork config edit)',
    defaults.map((r, i) => ({ value: String(i), label: r.skill, hint: describeRule(r) })),
    defaults.map((_, i) => String(i)),
  )
  const queue: Rule[] = []
  for (const rule of kept.map((i) => defaults[Number(i)] as Rule)) {
    const where = { ...rule.where }
    const [key, guess] =
      Object.entries(where).find(([k]) => values[rule.source ?? '']?.[k]?.length) ?? []
    const known = key ? (values[rule.source ?? '']?.[key] ?? []) : []
    if (key && typeof guess === 'string') {
      const description = input.skills[rule.skill]?.description ?? ''
      const pick = await ask.select(
        `Which ${key} holds the items for ${rule.skill}? ${description}`,
        [...known.map((v) => ({ value: v })), { value: '', label: 'none, drop this rule' }],
        known.find((v) => v.toLowerCase() === guess.toLowerCase()) ?? '',
      )
      if (!pick) continue
      where[key] = pick
    }
    queue.push({ ...rule, where })
  }

  const clock = async (message: string, initial: string) => {
    let value = await ask.text(message, { initial })
    while (!time.safeParse(value).success)
      value = await ask.text(`${message} (HH:MM, 24 hours)`, { initial })
    return value
  }
  const start = await clock('Window starts at', '01:00')
  const end = await clock('Window ends at', '07:00')
  return renderConfig({ window: { start, end }, providers: picked, sources: configs, queue })
}

const commented = (line: string, comment: string) => `${line.padEnd(31)} # ${comment}`

export function renderConfig(c: {
  window: { start: string; end: string }
  providers: string[]
  sources: Record<string, unknown>
  queue: Rule[]
}): string {
  return [
    '# awaywork config: `awaywork config edit` validates on save,',
    '# `awaywork plan` previews the next run, `awaywork plan --rules` what each rule takes.',
    `windows: [{ start: "${c.window.start}", end: "${c.window.end}" }]`,
    'budget:                         # every provider; override one with - <id>: { budget: … }',
    commented('  reserve: 10%', 'never go past 1 - reserve of any window'),
    commented('  session_max: 90%', 'stop a worker past this share of the short window'),
    commented('  present_session_max: 40%', 'the same, in a run outside every window'),
    commented('  # per_run: 15%', 'at most this share of the long window per run'),
    commented(`providers: ${flow(c.providers)}`, 'order = routing preference'),
    'sources:',
    ...Object.entries(c.sources).map(([id, cfg]) => `  ${id}: ${flow(cfg)}`),
    c.queue.length > 0 ? queueYaml(c.queue) : 'queue: []\n',
  ].join('\n')
}
