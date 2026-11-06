import type { Readable } from 'node:stream'
import { text } from 'node:stream/consumers'
import { isCancel, password } from '@clack/prompts'
import type { Command } from 'commander'
import { envFile } from '../config/paths.js'
import { saveSecret } from './ask.js'

export function secretCommand(program: Command): void {
  program
    .command('secret')
    .argument('<name>', 'the variable, e.g. ASANA_TOKEN')
    .description(
      'save a token to ~/.config/awaywork/env (mode 600), from a hidden prompt or a pipe',
    )
    .action(async (name: string) => {
      const saved = await secretFrom(name, process.stdin).catch((e: Error) => e)
      if (saved instanceof Error) {
        console.error(saved.message)
        process.exitCode = 1
      } else console.log(saved)
    })
}

/** Saves what a terminal's hidden prompt or a pipe gives for `name`; the line to print. */
export async function secretFrom(
  name: string,
  input: Readable & { isTTY?: boolean },
  file = envFile,
): Promise<string> {
  if (!/^[A-Z_][A-Z0-9_]*$/.test(name))
    throw new Error(`${name} isn't a variable name: capitals, digits and _, like ASANA_TOKEN`)
  const value = input.isTTY
    ? await password({ message: `${name}, saved in ${file}` })
    : (await text(input)).replace(/\r?\n$/, '')
  if (isCancel(value)) throw new Error('Cancelled, nothing saved')
  if (!value) throw new Error(`Nothing saved: the value for ${name} is empty`)
  if (/[\r\n]/.test(value)) throw new Error(`Nothing saved: the value for ${name} spans lines`)
  await saveSecret(name, value, file)
  return `Saved ${name} in ${file}`
}
