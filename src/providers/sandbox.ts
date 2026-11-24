import type { execa } from 'execa'
import { bin } from '#config/paths'
import { inImage } from '#core/isolation/container'
import { type Where, wallUp } from '#core/isolation/index'
import { sudoArgs } from '#core/isolation/sudo'
import { withholdsGrants } from '#core/trust'
import type { Provider, Unit } from '#core/types'

const BWRAP_PROBE = ['--unshare-user', '--unshare-net', '--unshare-pid', '--ro-bind', '/', '/']
export const PROC = ['--proc', '/proc']
export const DEV = ['--dev', '/dev']
const sandboxes = new Map<string, boolean>()

/**
 * Whether an agent's sandbox can start `where`: bubblewrap with the namespaces it takes, on Linux; Seatbelt elsewhere needs nothing.
 * It runs outside `start`, so no exit kills the worker's processes, and once per process for each image or user.
 */
export const bwrapStarts = (
  tool: string,
  where: Where,
  inner: string[],
  signal: AbortSignal | undefined,
  run: typeof execa,
) =>
  !where.image && process.platform !== 'linux'
    ? Promise.resolve(true)
    : startsWhere(tool, where, 'bwrap', [...BWRAP_PROBE, ...inner], signal, run)

export async function startsWhere(
  tool: string,
  { image, user }: Where,
  file: string,
  args: string[],
  signal: AbortSignal | undefined,
  run: typeof execa,
): Promise<boolean> {
  const key = `${tool} ${image ?? user ?? ''}`
  const known = sandboxes.get(key)
  if (known !== undefined) return known
  const options = { reject: false, cancelSignal: signal } as const
  const ran = image
    ? await run(bin('docker'), inImage(image, [file, ...args]), options)
    : user
      ? await run(bin('sudo'), sudoArgs(user, file, args, { env: {}, extendEnv: false }), {
          ...options,
          env: {},
          extendEnv: false,
        })
      : await run(bin(file), args, options)
  // Docker's own failure (125) says nothing about the sandbox, and may pass later.
  if (!signal?.aborted && ran.exitCode !== 125) sandboxes.set(key, !ran.failed)
  return !ran.failed
}

/** What each agent's shell sandbox needs, as `doctor` says it. */
export const sandboxNeeds = (agent: string) =>
  agent === 'claude'
    ? 'bubblewrap, socat and user namespaces'
    : agent === 'codex'
      ? 'bubblewrap and user namespaces'
      : 'user namespaces'

/** What an agent's shell could do without its sandbox: Codex's reads every file either way. */
const unsandboxed = (agent: string) =>
  agent === 'claude'
    ? 'read CLAUDE_CODE_OAUTH_TOKEN'
    : 'write outside the clone and reach the network'

/**
 * Why a unit can't run `where`: its agent's shell sandbox can't start there, and either awaywork's wall doesn't hold, so
 * its shell would reach any host, or an author off `trust` steers it, wall or not. A provider with no sandbox is exempt.
 */
export async function shellRefusal(
  provider: Provider,
  where: Where,
  unit: Pick<Unit, 'untrusted' | 'untrustedText'>,
  signal?: AbortSignal,
  walled = wallUp(),
): Promise<string | undefined> {
  const { id } = provider
  const untrusted = withholdsGrants(unit)
  if (!provider.startsSandbox || (walled && !untrusted)) return
  const steered = `an author off \`trust\` steers this unit, so its shell could ${unsandboxed(id)}`
  if (walled && provider.sandboxOffBehindWall)
    return `${id}'s shell sandbox stays off behind awaywork's network wall, and ${steered}`
  if (await provider.startsSandbox(where, signal)) return
  const cant = `${id}'s shell sandbox can't start here (needs ${sandboxNeeds(id)})`
  if (untrusted) return `${cant} and ${steered}: install them where units run`
  return `${cant} and no network wall holds: install them, or run under isolation: user, whose wall \`awaywork doctor\` shows`
}
