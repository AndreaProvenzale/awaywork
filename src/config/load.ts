import { readFile } from 'node:fs/promises'
import { parseDocument } from 'yaml'
import type { z } from 'zod'
import { defaultConfigPath } from './paths.js'
import { type Config, configSchema } from './schema.js'

export class ConfigError extends Error {
  constructor(
    readonly path: string,
    readonly problems: string[],
  ) {
    super(`${path}:\n${problems.map((p) => `  ${p}`).join('\n')}`)
  }
}

export function configPath(flag?: string): string {
  return flag ?? process.env.NIGHT_SHIFT_CONFIG ?? defaultConfigPath
}

export async function loadConfig(path: string): Promise<Config> {
  const text = await readFile(path, 'utf8').catch((e: NodeJS.ErrnoException) => {
    throw new ConfigError(path, [e.code === 'ENOENT' ? 'file not found' : e.message])
  })
  return parseConfig(text, path)
}

export function parseConfig(text: string, path = '<config>'): Config {
  const doc = parseDocument(text)
  if (doc.errors.length > 0)
    throw new ConfigError(
      path,
      doc.errors.map((e) => e.message),
    )
  const result = configSchema.safeParse(doc.toJS())
  if (!result.success) throw new ConfigError(path, result.error.issues.map(formatIssue))
  return result.data
}

function formatIssue(issue: z.core.$ZodIssue): string {
  const at = issue.path
    .map((p, i) => (typeof p === 'number' ? `[${p}]` : i === 0 ? String(p) : `.${String(p)}`))
    .join('')
  return at ? `${at}: ${issue.message}` : issue.message
}
