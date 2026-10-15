import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import type { Command } from 'commander'
import { execa } from 'execa'
import { z } from 'zod'
import { ConfigError, configPath, loadConfig, parseConfig } from '../config/load.js'
import { skillsDirOf } from '../config/paths.js'
import { configSchema } from '../config/schema.js'
import { unknownSkillsWarning } from '../config/skills.js'
import { terminalAsk } from './ask.js'
import { staleSchedules } from './schedule.js'

export function configCommand(program: Command): void {
  const config = program.command('config').description('print the config schema or edit the config')

  config
    .command('schema')
    .description('print the config JSON Schema, for editor autocompletion')
    .action(() => {
      console.log(JSON.stringify(z.toJSONSchema(configSchema, { io: 'input' }), null, 2))
    })

  config
    .command('edit')
    .description('open the config in $VISUAL or $EDITOR; it is saved only once valid')
    .action(async () => {
      const path = configPath(program.opts().config)
      const original = await readFile(path, 'utf8').catch(() => undefined)
      if (original === undefined) {
        console.error(`${path} not found; awaywork init writes one`)
        process.exitCode = 1
        return
      }
      const draft = join(await mkdtemp(join(tmpdir(), 'awaywork-')), basename(path))
      const [bin = 'vi', ...args] = (process.env.VISUAL || process.env.EDITOR || 'vi').split(' ')
      const outcome = await editUntilValid({
        path,
        original,
        draft,
        edit: async () => void (await execa(bin, [...args, draft], { stdio: 'inherit' })),
        retry: (e) => {
          console.error(e.message)
          return terminalAsk.confirm('Edit again? No keeps the saved config as it was')
        },
      })
      console.log(
        {
          saved: `Saved ${path}`,
          unchanged: 'No change',
          discarded: `Not saved; the draft is in ${draft}`,
        }[outcome],
      )
      if (outcome === 'saved') {
        const config = await loadConfig(path)
        const unknown = await unknownSkillsWarning(config, skillsDirOf(path))
        if (unknown) console.error(`warning: ${unknown}`)
        for (const warning of await staleSchedules(path, config.windows))
          console.error(`warning: ${warning}`)
      }
    })
}

/** Edits a draft copy until it validates, then writes it over the config. */
export async function editUntilValid(input: {
  path: string
  original: string
  draft: string
  edit(): Promise<void>
  retry(e: ConfigError): Promise<boolean>
}): Promise<'saved' | 'unchanged' | 'discarded'> {
  await writeFile(input.draft, input.original)
  for (;;) {
    await input.edit()
    const text = await readFile(input.draft, 'utf8')
    if (text === input.original) return 'unchanged'
    try {
      parseConfig(text, input.path)
      await writeFile(input.path, text)
      return 'saved'
    } catch (e) {
      if (!(e instanceof ConfigError)) throw e
      if (!(await input.retry(e))) return 'discarded'
    }
  }
}

export function reportConfigError(e: unknown): void {
  if (!(e instanceof ConfigError)) throw e
  console.error(e.message)
  process.exitCode = 1
}
