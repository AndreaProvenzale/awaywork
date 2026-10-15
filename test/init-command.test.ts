import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Command } from 'commander'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { printBrand } from '../src/cli/ask.js'
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

const tty = { stdin: process.stdin.isTTY, stdout: process.stdout.isTTY }
afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
  process.stdin.isTTY = tty.stdin
  process.stdout.isTTY = tty.stdout
  process.exitCode = undefined
})

describe('init command', () => {
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
    expect(text).not.toContain('awaywork  ')
  })

  it('prints no brand header with --yes, even in a terminal', async () => {
    process.stdin.isTTY = true
    process.stdout.isTTY = true
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    const config = join(await mkdtemp(join(tmpdir(), 'ns-init-')), 'config.yaml')
    const program = new Command().option('--config <path>')
    initCommand(program)
    await program.parseAsync(['--config', config, 'init', '--yes', '--source', 'github'], {
      from: 'user',
    })
    expect(log).not.toHaveBeenCalled()
  })
})

describe('printBrand', () => {
  it('prints the plain header under NO_COLOR when both ends are terminals', () => {
    process.stdin.isTTY = true
    process.stdout.isTTY = true
    vi.stubEnv('NO_COLOR', '1')
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    printBrand()
    expect(log).toHaveBeenCalledWith("☾ >_ awaywork  You're away, your agents work\n")
  })

  it('prints nothing when stdin or stdout is not a terminal', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    process.stdin.isTTY = false
    process.stdout.isTTY = true
    printBrand()
    process.stdin.isTTY = true
    process.stdout.isTTY = false
    printBrand()
    expect(log).not.toHaveBeenCalled()
  })
})
