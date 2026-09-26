import { appendFile, mkdir, readFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { confirm, isCancel, log, multiselect, password, select, text } from '@clack/prompts'
import { envFile } from '../config/paths.js'
import type { Ask, Choice } from '../core/types.js'

export class Cancelled extends Error {}

function answer<T>(value: T): Exclude<T, symbol> {
  if (isCancel(value)) throw new Cancelled('cancelled')
  return value as Exclude<T, symbol>
}

export const terminalAsk: Ask = {
  text: async (message, opts = {}) =>
    answer(
      await text({
        message,
        initialValue: opts.initial,
        defaultValue: opts.initial,
        placeholder: opts.placeholder,
      }),
    ) ?? '',
  select: async <T extends string>(message: string, choices: Choice<T>[], initial?: T) =>
    answer(await select<string>({ message, options: choices, initialValue: initial })) as T,
  multiselect: async <T extends string>(message: string, choices: Choice<T>[], initial?: T[]) =>
    answer(
      await multiselect<string>({
        message,
        options: choices,
        initialValues: initial,
        required: false,
      }),
    ) as T[],
  confirm: async (message, initial = true) =>
    answer(await confirm({ message, initialValue: initial })),
  async secret(name, message) {
    const value = answer(
      await password({ message: `${message}, saved as ${name} in ${envFile}; empty to skip` }),
    )
    if (!value) return ''
    await saveSecret(name, value)
    process.env[name] = value
    return value
  },
  note: (message) => log.info(message),
}

/** Appends to the env file, created with mode 600. */
export async function saveSecret(name: string, value: string, file = envFile): Promise<void> {
  await mkdir(dirname(file), { recursive: true })
  const existing = await readFile(file, 'utf8').catch(() => '')
  const separator = existing && !existing.endsWith('\n') ? '\n' : ''
  await appendFile(file, `${separator}${name}=${value}\n`, { mode: 0o600 })
}
