import { existsSync, statSync } from 'node:fs'
import type { Command } from 'commander'
import { configPath, loadConfig } from '../config/load.js'
import { envFile } from '../config/paths.js'
import type { Config } from '../config/schema.js'
import { allowance } from '../core/budget.js'
import type { Ctx } from '../core/types.js'
import { exec } from '../forge/gh.js'
import { providers } from '../providers/index.js'
import { sources } from '../sources/index.js'
import { describeAllowance, type Status, statusMarker } from './format.js'

export function doctorCommand(program: Command): void {
  program
    .command('doctor')
    .description('check binaries, credentials, quota and sources before a night')
    .action(async () => {
      let failed = false
      const color = Boolean(process.stdout.isTTY) && !process.env.NO_COLOR
      const report = (status: Status, what: string, detail = '') => {
        failed ||= status === 'FAIL'
        console.log(`${statusMarker(status, color)}  ${what}${detail && `: ${detail}`}`)
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
      const path = configPath(program.opts().config)
      try {
        config = await loadConfig(path)
        report('ok', path)
      } catch (e) {
        report('FAIL', path, (e as Error).message.split('\n').slice(1).join('; ').trim())
        process.exitCode = 1
        return
      }

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
        report(
          provider.unattended === 'allowed' ? 'ok' : 'warn',
          id,
          facts.filter(Boolean).join(', '),
        )
        await provider.probe(ctx).then(
          (quota) => {
            const a = allowance(budget, quota, Date.now())
            report(a.kind === 'quota' ? 'ok' : 'warn', `${id} tonight`, describeAllowance(a))
          },
          (e: Error) => report('FAIL', `${id} probe`, e.message),
        )
      }

      for (const [id, cfg] of Object.entries(config.sources)) {
        const source = sources[id]
        if (!source) continue
        const secrets = source.secrets(cfg).map(secret)
        await source.items(cfg, ctx).then(
          (items) => report('ok', id, [`${items.length} open items`, ...secrets].join(', ')),
          (e: Error) => report('FAIL', id, [e.message, ...secrets].join(', ')),
        )
      }
      if (failed) process.exitCode = 1
    })
}
