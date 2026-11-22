import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { containerMode } from '#core/isolation/container'
import { contain, useMode, whereRuns } from '#core/isolation/index'
import { none } from '#core/isolation/none'
import { userMode } from '#core/isolation/user'
import { sandboxStarts } from '#providers/claude'
import { codexSandboxStarts } from '#providers/codex'
import { cursorSandboxStarts } from '#providers/cursor'

type Run = Parameters<typeof sandboxStarts>[2]

const FLAGS = [
  '--unshare-user',
  '--unshare-net',
  '--unshare-pid',
  '--ro-bind',
  '/',
  '/',
  '--proc',
  '/proc',
  '--dev',
  '/dev',
  'bwrap',
  '--unshare-user',
  '--ro-bind',
  '/',
  '/',
  'socat',
  '-V',
]

describe('sandboxStarts', () => {
  const calls: { file: string; args: string[]; options: Record<string, unknown> }[] = []
  const fake = (failed: boolean) =>
    (async (file: string, args: string[], options: Record<string, unknown>) => {
      calls.push({ file, args, options })
      return { failed }
    }) as unknown as Run

  beforeEach(() => {
    calls.length = 0
    vi.spyOn(process, 'platform', 'get').mockReturnValue('linux')
  })
  afterEach(() => {
    vi.restoreAllMocks()
    useMode(none)
  })

  it('runs bwrap itself as the developer', async () => {
    expect(await sandboxStarts({}, undefined, fake(false))).toBe(true)
    expect(calls[0]?.file).toMatch(/bwrap$/)
    expect(calls[0]?.args).toEqual(FLAGS)
  })

  it('runs it through plain sudo as the worker, with the same flags', async () => {
    expect(await sandboxStarts({ user: 'probe-worker' }, undefined, fake(false))).toBe(true)
    const { file, args } = calls[0] ?? { file: '', args: [] }
    expect(file).toMatch(/sudo$/)
    expect(args).toContain('probe-worker')
    expect(args.slice(-FLAGS.length)).toEqual(FLAGS)
    expect(calls).toHaveLength(1)
  })

  it('runs it in the image under a container, on any host', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin')
    expect(await sandboxStarts({ image: 'probe/image:one' }, undefined, fake(true))).toBe(false)
    expect(calls[0]?.file).toMatch(/docker$/)
    expect(calls[0]?.args.slice(-FLAGS.length - 2)).toEqual(['probe/image:one', 'bwrap', ...FLAGS])
  })

  it('needs no probe as the developer or the worker off Linux', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin')
    expect(await sandboxStarts({ user: 'probe-mac' }, undefined, fake(true))).toBe(true)
    expect(calls).toEqual([])
  })

  it('is false when bwrap fails or is missing', async () => {
    expect(await sandboxStarts({ user: 'probe-fails' }, undefined, fake(true))).toBe(false)
  })

  it("probes Codex's namespaces without the nested one, apart from Claude's answer", async () => {
    await sandboxStarts({ user: 'probe-both' }, undefined, fake(false))
    expect(await codexSandboxStarts({ user: 'probe-both' }, undefined, fake(true))).toBe(false)
    expect(calls[1]?.args.at(-1)).toBe('true')
    expect(calls[1]?.args).not.toContain('--proc')
    expect(calls).toHaveLength(2)
  })

  it('probes once for each image or user', async () => {
    const run = fake(false)
    await sandboxStarts({ image: 'probe/image:two' }, undefined, run)
    await sandboxStarts({ image: 'probe/image:two' }, undefined, run)
    await sandboxStarts({ image: 'probe/image:three' }, undefined, run)
    expect(calls).toHaveLength(2)
  })

  it("passes the unit's signal and doesn't keep an aborted answer", async () => {
    const controller = new AbortController()
    controller.abort()
    await sandboxStarts({ user: 'probe-signal' }, controller.signal, fake(true))
    expect(calls[0]?.options.cancelSignal).toBe(controller.signal)
    await sandboxStarts({ user: 'probe-signal' }, undefined, fake(false))
    expect(calls).toHaveLength(2)
  })

  it("doesn't keep docker's own failure", async () => {
    const docker = (async () => ({ failed: true, exitCode: 125 })) as unknown as Run
    expect(await sandboxStarts({ image: 'probe/image:five' }, undefined, docker)).toBe(false)
    expect(await sandboxStarts({ image: 'probe/image:five' }, undefined, fake(false))).toBe(true)
  })

  it('looks where the phase runs: the image under a container, else the worker', () => {
    useMode(containerMode())
    contain('/clone', { image: 'probe/image:four', secrets: [] })
    expect(whereRuns('/clone')).toEqual({ image: 'probe/image:four' })
    useMode(userMode('awaywork'))
    expect(whereRuns('/clone')).toEqual({ user: 'awaywork' })
  })
})

describe('cursorSandboxStarts', () => {
  const calls: { file: string; args: string[] }[] = []
  const fake = (failed: boolean) =>
    (async (file: string, args: string[]) => {
      calls.push({ file, args })
      return { failed }
    }) as unknown as Run

  it("runs Cursor's own helper check beside the binary, as the developer, the worker or in the image, on any host", async () => {
    calls.length = 0
    vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin')
    expect(await cursorSandboxStarts('agent', {}, undefined, fake(false))).toBe(true)
    expect(await cursorSandboxStarts('agent', { user: 'cursor-w' }, undefined, fake(false))).toBe(
      true,
    )
    expect(await cursorSandboxStarts('agent', { image: 'cursor/img' }, undefined, fake(true))).toBe(
      false,
    )
    expect(calls.map((c) => c.file.split('/').at(-1))).toEqual(['sh', 'sudo', 'docker'])
    for (const { args } of calls) {
      expect(args.at(-1)).toBe('agent')
      expect(args.join(' ')).toContain('cursorsandbox" --policy /dev/stdin --preflight-only')
    }
    vi.restoreAllMocks()
  })

  it("probes once for each binary and where, apart from Claude's probe", async () => {
    calls.length = 0
    const run = fake(false)
    await cursorSandboxStarts('agent', { user: 'cursor-once' }, undefined, run)
    await cursorSandboxStarts('agent', { user: 'cursor-once' }, undefined, run)
    await cursorSandboxStarts('agent2', { user: 'cursor-once' }, undefined, run)
    expect(calls).toHaveLength(2)
  })
})
