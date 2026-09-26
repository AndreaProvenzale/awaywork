import { existsSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { Command } from 'commander'
import { configPath, loadConfig } from '../config/load.js'
import { exec } from '../forge/gh.js'
import { providers } from '../providers/index.js'
import { workflow } from '../scheduler/github-actions.js'
import { sources } from '../sources/index.js'
import { reportConfigError } from './config.js'

const WORKFLOW = '.github/workflows/night-shift.yml'
const REPO_CONFIG = '.night-shift/config.yml'

export function ciCommand(program: Command): void {
  const ci = program.command('ci').description('run night-shift in GitHub Actions')

  ci.command('init')
    .description(`write ${WORKFLOW} in this repo, reading the config from ${REPO_CONFIG}`)
    .action(async () => {
      const root = await exec('git', ['rev-parse', '--show-toplevel']).catch(() => undefined)
      if (!root) {
        console.error('not inside a git repository')
        process.exitCode = 1
        return
      }
      const file = join(root, WORKFLOW)
      if (existsSync(file)) {
        console.error(`${WORKFLOW} already exists; delete it to write a new one`)
        process.exitCode = 1
        return
      }
      try {
        const config = await loadConfig(configPath(program.opts().config))
        const used = config.providers.flatMap((p) => providers[p.id] ?? [])
        const secrets = new Set([
          'GH_TOKEN',
          ...used.flatMap((p) => p.secrets),
          ...Object.entries(config.sources).flatMap(([id, cfg]) => sources[id]?.secrets(cfg) ?? []),
        ])
        await mkdir(dirname(file), { recursive: true })
        await writeFile(
          file,
          workflow({
            start: config.night.start,
            timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
            config: REPO_CONFIG,
            packages: used.map((p) => p.package),
            secrets: [...secrets],
          }),
        )
        console.log(`Wrote ${WORKFLOW}. Before the first night:`)
        console.log(`  commit your config as ${REPO_CONFIG}`)
        console.log(`  add these repository secrets: ${[...secrets].join(', ')}`)
        console.log('  GH_TOKEN is a token of yours that reads your PRs and pushes to their repos')
      } catch (e) {
        reportConfigError(e)
      }
    })
}
