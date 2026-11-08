import type { EngineInterface } from 'claude-code'

const FIX = 'npm i -g awaywork@latest'

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
  if (/unknown option '--json'/.test(r.stderr))
    return { error: `this awaywork is too old for the pane (no --json): ${FIX}` }
  if (r.exitCode !== 0)
    return { failed: firstLine(r.stderr) || `awaywork ${args.join(' ')} exited ${r.exitCode}` }
  try {
    return { json: JSON.parse(r.stdout) as T }
  } catch {
    return { failed: `awaywork ${args.join(' ')} printed no JSON` }
  }
}
