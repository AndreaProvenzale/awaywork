import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Command } from 'commander'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { type Handoff, handOff, initCommand, withoutEnvFile } from '../src/cli/commands/init.js'
import { printBrand } from '../src/cli/format/ask.js'
import { pluginDir } from '../src/config/paths.js'

vi.mock('../src/providers/index.js', async () => {
  const { fakeProvider } = await import('./fakes/provider.js')
  const providers = { claude: fakeProvider('claude') }
  return {
    providers,
    providerFor: (id: string) => providers[id as 'claude'],
    providersOf: () => providers,
  }
})
vi.mock('../src/forge/gh.js', async (original) => ({
  ...(await original<typeof import('../src/forge/gh.js')>()),
  exec: async () => {
    throw new Error('gh: not logged in')
  },
}))

const tty = {
  stdin: process.stdin.isTTY,
  stdout: process.stdout.isTTY,
  hasColors: process.stdout.hasColors,
}
afterEach(() => {
  vi.restoreAllMocks()
  process.stdin.isTTY = tty.stdin
  process.stdout.isTTY = tty.stdout
  process.stdout.hasColors = tty.hasColors
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

  it('refuses without a terminal or --yes, pointing at /away', async () => {
    process.stdin.isTTY = false
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const program = new Command().option('--config <path>')
    initCommand(program)
    await program.parseAsync(['init'], { from: 'user' })
    expect(error).toHaveBeenCalledWith(expect.stringContaining('/away'))
    expect(process.exitCode).toBe(1)
  })
})

describe('handOff', () => {
  const absent = '[]'
  const installed = (enabled: boolean, installPath = pluginDir) =>
    JSON.stringify([{ id: 'awaywork@awaywork', enabled, installPath }])
  const enabled = installed(true)
  const disabled = installed(false)
  const fake = ({
    plugins = absent,
    after = enabled,
    claude = true,
    marketplaces = '[]',
    answer = undefined as boolean | undefined,
    failing = '',
  } = {}) => {
    const ran: string[] = []
    const printed: string[] = []
    const io: Handoff = {
      output: async (_cmd, args) =>
        !claude
          ? undefined
          : args[0] === '--version'
            ? '2.1.319'
            : args[1] === 'marketplace'
              ? marketplaces
              : ran.length
                ? after
                : plugins,
      spawn: (cmd, args, env) => {
        ran.push([cmd, ...args, ...(env ? [env.AWAYWORK_CONFIG] : [])].join(' '))
        return failing && args.join(' ').includes(failing) ? 1 : 0
      },
      confirm: async () => answer,
      print: (message) => printed.push(message),
    }
    return { io, ran, printed }
  }
  const fresh = { path: '/home/me/.config/awaywork/config.yml', exists: false }
  const marketplace = 'claude plugin marketplace add AndreaProvenzale/awaywork'
  const install = 'claude plugin install awaywork@awaywork'
  const update = 'claude plugin marketplace update awaywork'
  const added = JSON.stringify([{ name: 'awaywork' }])
  const setUp = `claude /away set up awaywork ${fresh.path}`
  const withPluginDir = `claude --plugin-dir ${pluginDir} /away set up awaywork ${fresh.path}`

  it('opens /away right away when the plugin is enabled', async () => {
    const { io, ran } = fake({ plugins: enabled })
    expect(await handOff(io, fresh)).toBe(0)
    expect(ran).toEqual([setUp])
  })

  it('installs the plugin on a yes, then opens /away', async () => {
    const { io, ran } = fake({ answer: true })
    await handOff(io, fresh)
    expect(ran).toEqual([marketplace, install, setUp])
  })

  it('updates the awaywork marketplace already added, then installs from it', async () => {
    const { io, ran } = fake({ marketplaces: added, answer: true })
    await handOff(io, fresh)
    expect(ran).toEqual([update, install, setUp])
  })

  it("loads the package's plugin when the one just installed has no setup skill", async () => {
    const { io, ran, printed } = fake({ answer: true, after: installed(true, '/nowhere') })
    await handOff(io, fresh)
    expect(ran).toEqual([marketplace, install, withPluginDir])
    expect(printed[0]).toContain('predates its setup skill')
    expect(printed[0]).not.toContain('updates yours')
  })

  it("loads the package's plugin when the updated marketplace still serves a stale one", async () => {
    const { io, ran } = fake({
      plugins: installed(false, '/nowhere'),
      marketplaces: added,
      answer: true,
      after: installed(true, '/nowhere'),
    })
    await handOff(io, fresh)
    expect(ran).toEqual([update, 'claude plugin enable awaywork@awaywork', withPluginDir])
  })

  it('enables a disabled plugin on a yes', async () => {
    const { io, ran } = fake({ plugins: disabled, answer: true })
    await handOff(io, fresh)
    expect(ran).toEqual(['claude plugin enable awaywork@awaywork', setUp])
  })

  it("loads the package's plugin for the session on a no", async () => {
    const { io, ran } = fake({ answer: false })
    await handOff(io, fresh)
    expect(ran).toEqual([withPluginDir])
  })

  it("falls back to the package's plugin when the install fails, stopping at the failed step", async () => {
    const { io, ran, printed } = fake({ answer: true, failing: 'marketplace' })
    await handOff(io, fresh)
    expect(ran).toEqual([marketplace, withPluginDir])
    expect(printed[0]).toContain('That failed')
  })

  it("loads the package's plugin over one without the setup skill", async () => {
    const { io, ran, printed } = fake({ plugins: installed(true, '/nowhere') })
    await handOff(io, fresh)
    expect(ran).toEqual([withPluginDir])
    expect(printed[0]).toContain('claude plugin update awaywork@awaywork')
  })

  it('returns what claude exits with', async () => {
    const { io } = fake({ plugins: enabled, failing: '/away' })
    expect(await handOff(io, fresh)).toBe(1)
  })

  it('runs nothing when the question is cancelled', async () => {
    const { io, ran } = fake()
    expect(await handOff(io, fresh)).toBe(1)
    expect(ran).toEqual([])
  })

  it('asks /away about the config there is', async () => {
    const { io, ran } = fake({ plugins: enabled })
    await handOff(io, { ...fresh, exists: true })
    expect(ran).toHaveLength(1)
    expect(ran[0]).toMatch(/^claude \/away awaywork has a config already: /)
  })

  it('says what to do instead without Claude Code', async () => {
    const { io, ran, printed } = fake({ claude: false })
    expect(await handOff(io, fresh)).toBe(0)
    expect(ran).toEqual([])
    expect(printed.join('\n')).toMatch(/codex plugin add awaywork@awaywork[\s\S]*init --yes/)
  })
})

describe('withoutEnvFile', () => {
  it("drops what the env file added but claude's login", () => {
    const env = { PATH: '/bin', ASANA_TOKEN: 'a', CLAUDE_CODE_OAUTH_TOKEN: 'c', SHELL_TOKEN: 's' }
    const file = { ASANA_TOKEN: 'a', CLAUDE_CODE_OAUTH_TOKEN: 'c', SHELL_TOKEN: 'other' }
    expect(withoutEnvFile(env, file)).toEqual({
      PATH: '/bin',
      CLAUDE_CODE_OAUTH_TOKEN: 'c',
      SHELL_TOKEN: 's',
    })
  })
})

describe('printBrand', () => {
  const terminal = (truecolor: boolean) => {
    process.stdin.isTTY = true
    process.stdout.isTTY = true
    const hasColors = vi.fn(() => truecolor)
    process.stdout.hasColors = hasColors
    return hasColors
  }

  it('prints the amber header when the terminal has truecolor', () => {
    const hasColors = terminal(true)
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    printBrand()
    expect(hasColors).toHaveBeenCalledWith(2 ** 24)
    expect(log).toHaveBeenCalledWith(expect.stringContaining('\u001b[38;2;247;178;64m>_'))
  })

  it('prints the plain header when the terminal lacks truecolor', () => {
    terminal(false)
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
