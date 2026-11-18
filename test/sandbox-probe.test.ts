import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { contain, containerize, isolate, sandboxStarts, whereRuns } from '#core/isolation'

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
    containerize(false)
    isolate(undefined)
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
    containerize(true)
    contain('/clone', { image: 'probe/image:four', secrets: [] })
    expect(whereRuns('/clone')).toEqual({ image: 'probe/image:four' })
    containerize(false)
    isolate('awaywork')
    expect(whereRuns('/clone')).toEqual({ user: 'awaywork' })
  })
})
