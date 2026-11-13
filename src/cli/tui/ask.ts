import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { parseEnv } from 'node:util'
import { confirm, isCancel, log, select } from '@clack/prompts'
import { ConfigError } from '#config/load'
import { envFile } from '#config/paths'
import type { Ask, Choice } from '#core/types'
import { brandHeader } from '#format/terminal'

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
  select: async <T extends string>(message: string, choices: Choice<T>[], initial?: T) =>
    answer(await select<string>({ message, options: choices, initialValue: initial })) as T,
  confirm: async (message, initial = true) =>
    answer(await confirm({ message, initialValue: initial })),
  note: (message) => log.info(message),
}

/**
 * Sets `name` in the env file, replacing its earlier lines and quoting the value when Node's
 * loader would otherwise read back something else; the file is never readable by others.
 */
export async function saveSecret(name: string, value: string, file = envFile): Promise<void> {
  const entry = [value, `'${value}'`, `"${value}"`, `\`${value}\``]
    .map((quoted) => `${name}=${quoted}`)
    // Twice, so a value that opens a quote can't swallow the next line, on every Node 22 too.
    .find((line) => parseEnv(`${line}\n${line}\n`)[name] === value)
  if (!entry) throw new Error(`Nothing saved: the env file can't hold that value for ${name}`)
  await mkdir(dirname(file), { recursive: true })
  const existing = await readFile(file, 'utf8').catch(() => '')
  const earlier = new RegExp(`^\\s*(export\\s+)?${name}\\s*=`)
  const kept = existing
    .split('\n')
    .filter((line) => !earlier.test(line))
    .join('\n')
  const separator = kept && !kept.endsWith('\n') ? '\n' : ''
  await chmod(file, 0o600).catch((e: NodeJS.ErrnoException) => {
    if (e.code !== 'ENOENT') throw e
  })
  await writeFile(file, `${kept}${separator}${entry}\n`, { mode: 0o600 })
}

export function reportConfigError(e: unknown): void {
  if (!(e instanceof ConfigError)) throw e
  console.error(e.message)
  process.exitCode = 1
}
