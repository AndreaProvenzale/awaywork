import { existsSync, statSync } from 'node:fs'
import type { Command } from 'commander'
import { configPath, loadConfig } from '../config/load.js'
import { envFile } from '../config/paths.js'
import type { Config } from '../config/schema.js'
import { allowance } from '../core/budget.js'
import type { Ctx } from '../core/types.js'
import { windowsOf } from '../core/window.js'
import { exec } from '../forge/gh.js'
import { providers } from '../providers/index.js'
import { staleWorkflow } from '../scheduler/github-actions.js'
import { isCommand } from '../sources/command.js'
import { sourceFor } from '../sources/index.js'
import { describeAllowance, type Status, statusMarker } from './format.js'
import { gitRoot, staleSchedules } from './schedule.js'

export interface Check {
  status: Status
  what: string
  detail: string
}

export function doctorCommand(program: Command): void {
  program
    .command('doctor')
    .description('check binaries, credentials, quota and sources before a night')
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

  let config: Config
  try {
    config = await loadConfig(path)
    report('ok', path)
  } catch (e) {
    report('FAIL', path, (e as Error).message.split('\n').slice(1).join('; ').trim())
    return checks
  }
  for (const warning of await staleSchedules(path, windowsOf(config)))
    report('warn', 'schedule', warning)
  const root = await gitRoot()
  const workflow = root && (await staleWorkflow(root))
  if (workflow) report('warn', 'schedule', workflow)

  for (const { id, budget } of config.providers) {
    const provider = providers[id]
    if (!provider) continue
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
        const a = allowance(budget, quota, Date.now(), undefined, windowsOf(config))
        report(a.kind === 'quota' ? 'ok' : 'warn', `${id} tonight`, describeAllowance(a))
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
