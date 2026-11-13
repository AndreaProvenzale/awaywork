import { readFile } from 'node:fs/promises'

/** `text` parsed, or undefined when it isn't JSON. */
// biome-ignore lint/suspicious/noExplicitAny: callers read fields off JSON whose shape they already know
export function parseJson<T = any>(text: string): T | undefined {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

/** The JSON in the file at `path`, or `fallback` when it can't be read or parsed. */
export async function readJson<T>(path: string, fallback: T): Promise<T> {
  const text = await readFile(path, 'utf8').catch(() => undefined)
  if (text === undefined) return fallback
  try {
    return JSON.parse(text) as T
  } catch {
    return fallback
  }
}
