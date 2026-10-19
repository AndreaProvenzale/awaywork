import { cp, lstat, mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Config } from '../config/schema.js'
import { slug } from '../core/foreman.js'
import type { Item } from '../core/types.js'
import { runCommand } from './setup.js'
import { setupEnv } from './steps.js'
import { WORK_DIR } from './workspace.js'

export type ContextSource = { context?: { command: string; secrets: string[] } }

/** The secrets of every source's context command. */
export const contextSecrets = (config: Config): string[] =>
  Object.values(config.sources).flatMap((cfg) => (cfg as ContextSource).context?.secrets ?? [])

const TIMEOUT_MS = 2 * 60_000
const MAX_BYTES = 1_000_000
const MAX_LOG = 4_000

interface ContextOptions {
  /** Names in `env` whose values are masked in the log. */
  secrets: string[]
  signal?: AbortSignal
  until?: Date
}

interface FetchInput {
  config: Config
  configDir: string
  env: NodeJS.ProcessEnv
  /** Every secret the config names, from `configSecrets`. */
  secrets: string[]
  log: (line: string) => void
  signal?: AbortSignal
  until?: Date
}

/** Runs each item's source's context command, if it has one, into the item's `extra/` in the clone; logs a failure. */
export async function fetchContexts(items: Item[], dir: string, f: FetchInput): Promise<void> {
  for (const item of items) {
    const fetch = (f.config.sources[item.source] as ContextSource | undefined)?.context
    if (!fetch) continue
    const failed = await runContext(
      fetch.command,
      item,
      f.configDir,
      join(dir, WORK_DIR, 'context', slug(item.key), 'extra'),
      setupEnv(f.env, dir, f.secrets, fetch.secrets),
      f.log,
      { secrets: fetch.secrets, signal: f.signal, until: f.until },
    )
    if (failed) f.log(failed)
  }
}

/**
 * Runs a source's context command for `item` in `cwd`, outside the clone, with a fresh output folder in
 * `AWAYWORK_CONTEXT_DIR`; copies what it wrote there into `extraDir` only if it succeeded within the limits.
 * Returns why not, never throws.
 */
export async function runContext(
  command: string,
  item: Item,
  cwd: string,
  extraDir: string,
  env: NodeJS.ProcessEnv,
  log: (line: string) => void,
  opts: ContextOptions,
): Promise<string | undefined> {
  const tmp = await mkdtemp(join(tmpdir(), 'awaywork-context-'))
  try {
    const itemFile = join(tmp, 'item.json')
    const out = join(tmp, 'out')
    await mkdir(out)
    await writeFile(itemFile, JSON.stringify(item, null, 2))
    const { output, failed } = await runCommand(
      command,
      cwd,
      {
        ...env,
        AWAYWORK_ITEM_KEY: item.key,
        AWAYWORK_ITEM_URL: item.url,
        AWAYWORK_ITEM_FILE: itemFile,
        AWAYWORK_CONTEXT_DIR: out,
      },
      { ...opts, timeoutMs: TIMEOUT_MS },
    )
    if (output) log(`context ${item.key}: ${output.slice(-MAX_LOG)}`)
    const why = failed ?? (await unfit(out))
    if (!why) await cp(out, extraDir, { recursive: true })
    return why && `context for ${item.key} failed: ${why}`
  } catch (e) {
    await rm(extraDir, { recursive: true, force: true })
    return `context for ${item.key} failed: ${(e as Error).message}`
  } finally {
    await rm(tmp, { recursive: true, force: true })
  }
}

/** Why `dir` can't go to the worker: something in it that isn't a regular file or folder, or more than the size limit. */
async function unfit(dir: string): Promise<string | undefined> {
  if (!(await lstat(dir)).isDirectory()) return 'AWAYWORK_CONTEXT_DIR is not a folder'
  let bytes = 0
  const walk = async (folder: string): Promise<string | undefined> => {
    for (const entry of await readdir(folder)) {
      const path = join(folder, entry)
      const stat = await lstat(path)
      if (stat.isDirectory()) {
        const why = await walk(path)
        if (why) return why
      } else if (stat.isFile()) bytes += stat.size
      else return `${entry} is not a regular file`
    }
    return undefined
  }
  const why = await walk(dir)
  return (
    why ?? (bytes > MAX_BYTES ? `wrote ${bytes} bytes, over the ${MAX_BYTES} limit` : undefined)
  )
}
