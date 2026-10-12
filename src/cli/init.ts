import { existsSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { cancel, intro, log, outro, spinner } from '@clack/prompts'
import { type Command, InvalidArgumentError } from 'commander'
import { flow, queueYaml } from '../config/edit.js'
import { ConfigError, configPath, parseConfig } from '../config/load.js'
import { builtinSkillsDir, skillsDirOf } from '../config/paths.js'
import { time } from '../config/schema.js'
import { loadSkills } from '../config/skills.js'
import { defaultRules } from '../core/queue.js'
import type { SkillMeta } from '../core/skills.js'
import type { Ask, Ctx, Provider, Rule, Source } from '../core/types.js'
import { exec } from '../forge/gh.js'
import { providers } from '../providers/index.js'
import { sources } from '../sources/index.js'
import { Cancelled, defaultAsk, terminalAsk } from './ask.js'
import { describeRule } from './format.js'
import { installSchedule } from './schedule.js'

export function initCommand(program: Command): void {
  program
    .command('init')
    .description('detect installed agents, pick providers, sources and a starting queue')
    .option('-y, --yes', 'answer every question with its default; needs no terminal')
    .option('--provider <id...>', 'with --yes: providers, first takes units first')
    .option('--source <id...>', 'with --yes: sources to take work from')
    .option('--window <start-end>', 'with --yes: the run window, e.g. 01:00-07:00', parseWindow)
    .option('--force', 'replace an existing config without asking')
    .action(async (opts: InitOptions) => {
      const path = configPath(program.opts().config)
      if (!opts.yes && !process.stdin.isTTY) {
        console.error(
          'init asks questions in a terminal; without one, pass --yes to take the detected defaults, or write the config by hand (`awaywork config schema` describes it) and run `awaywork config check`',
        )
        process.exitCode = 1
        return
      }
      const ask = opts.yes ? defaultAsk(presets(opts), (line) => log.info(line)) : terminalAsk
      intro('awaywork init')
      try {
        if (existsSync(path) && !opts.force) {
          if (opts.yes) {
            cancel(`${path} exists; --force replaces it`)
            process.exitCode = 1
            return
          }
          if (!(await ask.confirm(`Replace ${path}?`, false)))
            return outro('Kept the existing config')
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
        const text = await initConfig({ ask, ctx, installed, ghLogin, skills })
        parseConfig(text, path)
        await mkdir(dirname(path), { recursive: true })
        await writeFile(path, text)
        const scheduler = opts.yes ? 'later' : await whereToRun(terminalAsk).catch(() => 'later')
        if (scheduler === 'later')
          return outro(
            `Wrote ${path}. Next: awaywork doctor, awaywork plan, awaywork schedule install`,
          )
        outro(`Wrote ${path}. Next: awaywork doctor, awaywork plan`)
        await installSchedule(program.opts().config, scheduler || undefined)
      } catch (e) {
        if (e instanceof Cancelled) {
          cancel(opts.yes ? `Nothing written: ${e.message}` : 'Nothing written')
          process.exitCode = 1
        } else if (e instanceof ConfigError) {
          cancel(`Nothing written, the answers make an invalid config:\n${e.message}`)
          process.exitCode = 1
        } else throw e
      }
    })
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

/** The `schedule install --with` value: '' for this machine's default, or 'later'. */
const whereToRun = (ask: Ask) =>
  ask.select(
    'Where should it run on a schedule?',
    [
      { value: '', label: 'this machine' },
      { value: 'github-actions', label: 'GitHub Actions, from the repo in this directory' },
      { value: 'later', label: 'later, with awaywork schedule install' },
    ],
    '',
  )

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
  let picked: string[] = []
  while (picked.length === 0)
    picked = await ask.multiselect(
      'Providers (pick at least one)',
      ids.map((id) => ({ value: id, hint: installed.includes(id) ? undefined : 'not installed' })),
      ids.filter((id) => installed.includes(id)),
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
      Object.keys(registry.sources).map((id) => ({
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
    'Starting queue, top rule first (reorder later with awaywork queue)',
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
    '# `awaywork queue` reorders the queue, `awaywork plan` previews the next run.',
    `windows: [{ start: "${c.window.start}", end: "${c.window.end}" }]`,
    'budget:                         # every provider; override one with - <id>: { budget: … }',
    commented('  reserve: 10%', 'never go past 1 - reserve of any window'),
    commented('  session_max: 90%', 'stop a worker past this share of the short window'),
    commented('  # per_run: 15%', 'at most this share of the long window per run'),
    commented(`providers: ${flow(c.providers)}`, 'order = routing preference'),
    'sources:',
    ...Object.entries(c.sources).map(([id, cfg]) => `  ${id}: ${flow(cfg)}`),
    c.queue.length > 0 ? queueYaml(c.queue) : 'queue: []\n',
  ].join('\n')
}
