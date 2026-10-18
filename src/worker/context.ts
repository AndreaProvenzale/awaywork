import { lstat, mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Config } from '../config/schema.js'
import type { Item } from '../core/types.js'
import { runCommand } from './setup.js'

export type ContextSource = { context?: { command: string; secrets: string[] } }

/** The secrets of every source's context command. */
export const contextSecrets = (config: Config): string[] =>
  Object.values(config.sources).flatMap((cfg) => (cfg as ContextSource).context?.secrets ?? [])

const TIMEOUT_MS = 2 * 60_000
const MAX_BYTES = 1_000_000

interface ContextOptions {
  /** Names in `env` whose values are masked in the log. */
  secrets: string[]
  signal?: AbortSignal
}

/**
 * Runs a source's context command for `item` in `extraDir`; keeps what it wrote there only if it succeeded
 * within the limits. Returns why not, never throws.
 */
export async function runContext(
  command: string,
  item: Item,
  extraDir: string,
  env: NodeJS.ProcessEnv,
  log: (line: string) => void,
  opts: ContextOptions,
): Promise<string | undefined> {
  const itemDir = await mkdtemp(join(tmpdir(), 'awaywork-item-'))
  try {
    await mkdir(extraDir, { recursive: true })
    const itemFile = join(itemDir, 'item.json')
    await writeFile(itemFile, JSON.stringify(item, null, 2))
    const { output, failed } = await runCommand(
      command,
      extraDir,
      {
        ...env,
        AWAYWORK_ITEM_KEY: item.key,
        AWAYWORK_ITEM_URL: item.url,
        AWAYWORK_ITEM_FILE: itemFile,
      },
      { ...opts, timeoutMs: TIMEOUT_MS },
    )
    if (output) log(`context ${item.key}: ${output}`)
    const why = failed ?? (await tooBig(extraDir))
    if (why) await rm(extraDir, { recursive: true, force: true })
    return why && `context for ${item.key} failed: ${why}`
  } catch (e) {
    await rm(extraDir, { recursive: true, force: true })
    return `context for ${item.key} failed: ${(e as Error).message}`
  } finally {
    await rm(itemDir, { recursive: true, force: true })
  }
}

/** Why `dir` can't go to the worker: a symlink in it, or more than the size limit. */
async function tooBig(dir: string): Promise<string | undefined> {
  let bytes = 0
  const walk = async (folder: string): Promise<string | undefined> => {
    for (const entry of await readdir(folder)) {
      const path = join(folder, entry)
      const stat = await lstat(path)
      if (stat.isSymbolicLink()) return `${entry} is a symlink`
      if (stat.isDirectory()) {
        const why = await walk(path)
        if (why) return why
      } else bytes += stat.size
    }
    return undefined
  }
  const why = await walk(dir)
  return (
    why ?? (bytes > MAX_BYTES ? `wrote ${bytes} bytes, over the ${MAX_BYTES} limit` : undefined)
  )
}
