import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Command } from 'commander'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { initCommand } from '../src/cli/init.js'

vi.mock('../src/providers/index.js', async () => {
  const { fakeProvider } = await import('./fakes/provider.js')
  return { providers: { claude: fakeProvider('claude') } }
})
vi.mock('../src/forge/gh.js', async (original) => ({
  ...(await original<typeof import('../src/forge/gh.js')>()),
  exec: async () => {
    throw new Error('gh: not logged in')
  },
}))

describe('init command', () => {
  const tty = process.stdout.isTTY
  afterEach(() => {
    vi.restoreAllMocks()
    process.stdout.isTTY = tty
    process.exitCode = undefined
  })

  it('prints plain lines, no spinner frames, without a terminal', async () => {
    process.stdout.isTTY = false
    const out: string[] = []
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      out.push(String(chunk))
      return true
    })
    const config = join(await mkdtemp(join(tmpdir(), 'ns-init-')), 'config.yaml')
    const program = new Command().option('--config <path>')
    initCommand(program)
    await program.parseAsync(['--config', config, 'init', '--yes', '--source', 'github'], {
      from: 'user',
    })
    const text = out.join('')
    expect(text).toContain('claude: 1.0.0, gh: not logged in')
    expect(text).not.toContain('\u001b[')
  })
})
