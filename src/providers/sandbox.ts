import type { execa } from 'execa'
import { bin } from '#config/paths'
import { inImage } from '#core/isolation/container'
import { contained, type Where, wallUp } from '#core/isolation/index'
import { sudoArgs } from '#core/isolation/sudo'
import type { Job, Provider } from '#core/types'

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

/**
 * Why a unit can't run: its agent's shell sandbox can't start here and awaywork's wall doesn't hold, so its shell would
 * reach any host. `container` keeps running open until its wall lands; a provider with no sandbox is exempt.
 */
export async function shellRefusal(
  provider: Provider,
  job: Pick<Job, 'dir'>,
  signal?: AbortSignal,
): Promise<string | undefined> {
  if (!provider.startsSandbox || wallUp() || contained()) return
  if (await provider.startsSandbox(job, signal)) return
  return `${provider.id}'s shell sandbox can't start here (needs ${sandboxNeeds(provider.id)}) and no network wall holds: install them, or run under isolation: user, whose wall \`awaywork doctor\` shows`
}
