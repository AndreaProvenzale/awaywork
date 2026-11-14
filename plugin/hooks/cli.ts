import type { EngineInterface } from 'claude-code'

import { folderOf } from './text'

const FIX = 'npm i -g awaywork@latest'
export const DRAFT = 'config.draft.yml'

export type Got<T> = { json: T } | { error: string } | { failed: string }

export const firstLine = (text: string) => text.trim().split('\n')[0] ?? ''

export async function awaywork($: EngineInterface, args: string[], timeoutMs = 60_000) {
  try {
    return await $.process.run(['awaywork', ...args], { timeoutMs })
  } catch (e) {
    const why = String(e)
    return /ENOENT|not found|no such file/i.test(why)
      ? { exitCode: 127, stdout: '', stderr: '', missing: `awaywork isn't on your PATH: ${FIX}` }
      : { exitCode: 1, stdout: '', stderr: why }
  }
}

export async function json<T>(
  $: EngineInterface,
  args: string[],
  timeoutMs?: number,
): Promise<Got<T>> {
  const r = await awaywork($, args, timeoutMs)
  if ('missing' in r && r.missing) return { error: r.missing }
  const lacks = /unknown option '--json'/.test(r.stderr)
    ? '--json'
    : /unknown command 'explain'/.test(r.stderr)
      ? 'config explain'
      : undefined
  if (lacks) return { error: `this awaywork is too old for the pane (no ${lacks}): ${FIX}` }
  if (r.exitCode !== 0)
    return { failed: firstLine(r.stderr) || `awaywork ${args.join(' ')} exited ${r.exitCode}` }
  try {
    return { json: JSON.parse(r.stdout) as T }
  } catch {
    return { failed: `awaywork ${args.join(' ')} printed no JSON` }
  }
}

/** The config's path, or that of the config setup `named`, and the draft's beside it; `missing` when awaywork says there's none. */
export async function configPaths($: EngineInterface, named?: string, timeoutMs = 10_000) {
  const r = await awaywork($, [...(named ? ['--config', named] : []), 'config', 'path'], timeoutMs)
  const path = firstLine(r.stdout)
  const missing = r.exitCode === 1 && /not found; awaywork init writes one/.test(r.stderr)
  if (!path.startsWith('/')) return { missing }
  return { missing, path, draft: `${folderOf(path)}/${DRAFT}` }
}

let opener: string | undefined

export async function openUrl($: EngineInterface, url: string) {
  opener ??= (await $.process.run(['uname'])).stdout.trim() === 'Darwin' ? 'open' : 'xdg-open'
  await $.process.run([opener, url])
}

export async function openInEditor($: EngineInterface, file: string, line: number) {
  const code = await $.process.run(['code', '-g', `${file}:${line}`]).catch(() => undefined)
  if (code?.exitCode !== 0) await openUrl($, file)
}
