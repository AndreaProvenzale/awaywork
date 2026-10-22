import { appendFile, mkdir, readFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { confirm, isCancel, log, multiselect, password, select, text } from '@clack/prompts'
import { envFile } from '../config/paths.js'
import type { Ask, Choice } from '../core/types.js'
import { brandHeader } from './format.js'

export class Cancelled extends Error {}

/** The brand header, in truecolor when the terminal has it. */
export const terminalBrand = () => brandHeader(process.stdout.hasColors(2 ** 24))

/** The brand header, only in a terminal that can answer prompts. */
export function printBrand(): void {
  if (process.stdin.isTTY && process.stdout.isTTY) console.log(`${terminalBrand()}\n`)
}

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

/**
 * Answers each prompt with the first matching preset, else its default; a secret it cannot
 * prompt for fails the source asking, and a prompt asked again fails the whole run.
 */
export function defaultAsk(presets: [RegExp, unknown][], note: (message: string) => void): Ask {
  const asked = new Set<string>()
  const answer = <T>(message: string, fallback: T): T => {
    if (asked.has(message)) throw new Cancelled(`no default for "${message}"`)
    asked.add(message)
    const preset = presets.find(([pattern]) => pattern.test(message))
    return preset ? (preset[1] as T) : fallback
  }
  return {
    text: async (message, opts = {}) => answer(message, opts.initial ?? ''),
    select: async (message, choices, initial) =>
      answer(message, initial ?? (choices[0]?.value as never)),
    multiselect: async (message, _, initial) => answer(message, initial ?? []),
    confirm: async (message, initial = true) => answer(message, initial),
    secret: async (name) => {
      throw new Error(`${name} is not set`)
    },
    note,
  }
}

/** Appends to the env file, created with mode 600. */
export async function saveSecret(name: string, value: string, file = envFile): Promise<void> {
  await mkdir(dirname(file), { recursive: true })
  const existing = await readFile(file, 'utf8').catch(() => '')
  const separator = existing && !existing.endsWith('\n') ? '\n' : ''
  await appendFile(file, `${separator}${name}=${value}\n`, { mode: 0o600 })
}
