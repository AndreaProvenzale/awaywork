import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ghLogin, providerLogin } from '#cli/commands/doctor'
import { offerSecrets } from '#cli/commands/schedule'
import { ConfigError, loadConfig, parseConfig } from '#config/load'
import { pinLogins, pinned } from '#config/logins'
import type { Ask, Provider } from '#core/types'
import type { Exec } from '#forge/gh'
import { claudeProvider } from '#providers/claude'
import { codexProvider } from '#providers/codex'
import { recorded } from './fakes/gh'

const fake = (name: string) => fileURLToPath(new URL(`./fakes/${name}.mjs`, import.meta.url))
const folder = () => mkdtemp(join(tmpdir(), 'awaywork-login-'))
const github = (keys: string) =>
  parseConfig(
    `providers: [claude]\nforge: { github: { ${keys} } }\nrepos: { a/b: {} }\nsources: { github: {} }\n`,
  )
const withProvider = (entry: string, isolation = 'none') =>
  parseConfig(
    `isolation: ${isolation}\nproviders: [${entry}]\nrepos: { a/b: {} }\nsources: { github: {} }\n`,
  )
const problems = (text: string) => {
  try {
    parseConfig(text)
    return []
  } catch (e) {
    if (e instanceof ConfigError) return e.problems
    throw e
  }
}

describe('forge.github.user', () => {
  const token = recorded([[/^gh auth token --user octocat$/, 'gho_octocat\n']])

  it("makes the account's gh token GH_TOKEN, once", async () => {
    const env: NodeJS.ProcessEnv = {}
    const pins = await pinLogins(github('user: octocat'), env, token)
    expect(env.GH_TOKEN).toBe('gho_octocat')
    expect(pinned(env, 'GH_TOKEN')).toBe(true)
    expect(pins).toEqual([
      { what: 'gh', key: 'forge.github.user', name: 'GH_TOKEN', value: 'gho_octocat' },
    ])
  })

  it('leaves a token the environment has alone', async () => {
    for (const name of ['GH_TOKEN', 'GITHUB_TOKEN']) {
      const env: NodeJS.ProcessEnv = { [name]: 'from-actions' }
      const run = recorded([])
      const [pin] = await pinLogins(github('user: octocat'), env, run)
      expect(pin?.by).toBe(name)
      expect(env).toEqual({ [name]: 'from-actions' })
      expect(pinned(env, name)).toBe(false)
      expect(run.calls).toEqual([])
    }
  })

  it('takes an Enterprise host its own token, as GH_ENTERPRISE_TOKEN', async () => {
    const env: NodeJS.ProcessEnv = {}
    const run = recorded([[/^gh auth token --user octocat --hostname github\.acme\.com$/, 'ghe']])
    await pinLogins(github('host: github.acme.com, user: octocat'), env, run)
    expect(env).toEqual({ GH_ENTERPRISE_TOKEN: 'ghe' })
  })

  it('says how to log in when gh has no login for the account, and sets nothing', async () => {
    const env: NodeJS.ProcessEnv = {}
    const [pin] = await pinLogins(github('user: nobody'), env, recorded([]))
    expect(pin?.problem).toBe("nobody isn't logged in to gh; log in with gh auth login, as nobody")
    expect(env).toEqual({})
  })

  it('pins afresh when the config is loaded again, as watch does', async () => {
    const env: NodeJS.ProcessEnv = {}
    await pinLogins(github('user: octocat'), env, token)
    await pinLogins(github(''), env, token)
    expect(env).toEqual({})
    expect(pinned(env, 'GH_TOKEN')).toBe(false)
  })

  it("keeps the previous pin while a reload waits on gh, so a run spawned meanwhile doesn't act as gh's active account", async () => {
    const env: NodeJS.ProcessEnv = {}
    await pinLogins(github('user: octocat'), env, token)
    let answer = (_: string) => {}
    const slow = (async () => new Promise<string>((resolve) => (answer = resolve))) as Exec
    const reload = pinLogins(github('user: hubot'), env, slow)
    await Promise.resolve()
    expect(env.GH_TOKEN).toBe('gho_octocat')
    answer('gho_hubot')
    await reload
    expect(env.GH_TOKEN).toBe('gho_hubot')
  })

  it('keeps the previous pin when a reload fails, and still reports why', async () => {
    const env: NodeJS.ProcessEnv = {}
    await pinLogins(github('user: octocat'), env, token)
    const [pin] = await pinLogins(github('user: octocat'), env, recorded([]))
    expect(pin?.problem).toMatch("octocat isn't logged in to gh")
    expect(env.GH_TOKEN).toBe('gho_octocat')
    expect(pinned(env, 'GH_TOKEN')).toBe(true)
  })

  it("never takes a pinned token for the environment's own when two loads overlap", async () => {
    const env: NodeJS.ProcessEnv = {}
    await Promise.all([
      pinLogins(github('user: octocat'), env, token),
      pinLogins(github('user: octocat'), env, token),
    ])
    await Promise.all([
      pinLogins(github('user: octocat'), env, token),
      pinLogins(github('user: octocat'), env, token),
    ])
    const [pin] = await pinLogins(github('user: octocat'), env, token)
    expect(pin?.by).toBeUndefined()
    await pinLogins(github(''), env, token)
    expect(env).toEqual({})
    expect(pinned(env, 'GH_TOKEN')).toBe(false)
  })

  it('rejects anything but a login', () => {
    expect(
      problems(
        'providers: [claude]\nforge: { github: { user: "a b" } }\nrepos: { a/b: {} }\nsources: { github: {} }',
      ),
    ).toEqual(['forge.github.user: expected a GitHub login'])
  })
})

describe('config_dir', () => {
  afterEach(() => vi.unstubAllEnvs())

  it("points the provider's env var at the folder", async () => {
    const [claude, codex] = [await folder(), await folder()]
    const env: NodeJS.ProcessEnv = { CLAUDE_CONFIG_DIR: '/elsewhere' }
    const config = withProvider(
      `claude: { config_dir: ${claude} }, codex: { config_dir: ${codex} }`,
    )
    await pinLogins(config, env, recorded([]))
    expect(env).toEqual({ CLAUDE_CONFIG_DIR: claude, CODEX_HOME: codex })
    expect(config.providers[0]?.config).toEqual({})
  })

  it('unsets CLAUDE_CONFIG_DIR for ~/.claude, whose keychain login Claude Code only finds without it', async () => {
    const home = await folder()
    vi.stubEnv('HOME', home)
    await mkdir(join(home, '.claude'))
    const env: NodeJS.ProcessEnv = { CLAUDE_CONFIG_DIR: '/elsewhere' }
    await pinLogins(withProvider('claude: { config_dir: ~/.claude }'), env, recorded([]))
    expect(env).toEqual({})
  })

  it('leaves the login alone while the token env is set, so a runner without the folder still runs', async () => {
    const env: NodeJS.ProcessEnv = { CLAUDE_CODE_OAUTH_TOKEN: 't' }
    const [pin] = await pinLogins(
      withProvider('claude: { config_dir: /nowhere/.claude-work }'),
      env,
      recorded([]),
    )
    expect(pin?.by).toBe('CLAUDE_CODE_OAUTH_TOKEN')
    expect(env).toEqual({ CLAUDE_CODE_OAUTH_TOKEN: 't' })
  })

  it('refuses a missing folder with the login command, at load', async () => {
    const dir = await folder()
    const path = join(dir, 'config.yml')
    await writeFile(
      path,
      'providers: [claude: { config_dir: /nowhere/.claude-work }]\nrepos: { a/b: {} }\nsources: { github: {} }\n',
    )
    vi.stubEnv('CLAUDE_CODE_OAUTH_TOKEN', '')
    const error = await loadConfig(path).catch((e: ConfigError) => e)
    expect((error as ConfigError).problems).toEqual([
      "providers[0].claude.config_dir: /nowhere/.claude-work doesn't exist; log in there with CLAUDE_CONFIG_DIR=/nowhere/.claude-work claude /login",
    ])
    expect(await loadConfig(path, { pin: false })).toBeDefined()
  })

  it('is never empty nor relative, and only on providers with a login folder', () => {
    const at = (entry: string) =>
      problems(`providers: [${entry}]\nrepos: { a/b: {} }\nsources: { github: {} }`)
    const expected = 'expected an absolute path or one under ~/'
    expect(at("claude: { config_dir: '' }")).toEqual([
      `providers[0].claude.config_dir: ${expected}`,
    ])
    expect(at('codex: { config_dir: .codex }')).toEqual([
      `providers[0].codex.config_dir: ${expected}`,
    ])
    expect(at('cursor: { config_dir: ~/.cursor }')).toEqual([
      'providers[0].cursor: Unrecognized key: "config_dir"',
    ])
  })

  it("is refused under isolation for Claude, whose login isn't lent, and kept for Codex, whose is", async () => {
    for (const isolation of ['user', 'container'])
      expect(
        problems(
          `isolation: ${isolation}\nproviders: [claude: { config_dir: ~/.claude-work }]\nsources: { github: {} }\nrepos: { a/b: { image: node } }`,
        ),
      ).toEqual([
        `providers[0].claude.config_dir: not with isolation: ${isolation}, which can't reach your login folder; set CLAUDE_CODE_OAUTH_TOKEN instead`,
      ])
    const dir = await folder()
    await writeFile(join(dir, 'auth.json'), '{"tokens":{}}')
    const env = process.env
    await pinLogins(withProvider(`codex: { config_dir: ${dir} }`, 'user'), env, recorded([]))
    try {
      const codex = codexProvider(fake('codex'), join(dir, 'codex.lock'))
      const home = await folder()
      const save = await codex.login?.(home)
      expect(await readFile(join(home, '.codex', 'auth.json'), 'utf8')).toBe('{"tokens":{}}')
      await save?.(false)
    } finally {
      await pinLogins(withProvider('codex'), env, recorded([]))
    }
    expect(pinned(env, 'CODEX_HOME')).toBe(false)
  })
})

describe('the login doctor names', () => {
  afterEach(() => vi.unstubAllEnvs())
  const account = vi.fn(async () => 'dev@example.test, max')
  const claude: Provider = { ...claudeProvider(fake('claude')), account }

  it('names the pinned folder and its account', async () => {
    const dir = await folder()
    const env: NodeJS.ProcessEnv = {}
    const [pin] = await pinLogins(withProvider(`claude: { config_dir: ${dir} }`), env, recorded([]))
    expect(await providerLogin(claude, pin, env)).toEqual([
      'ok',
      'claude login',
      `dev@example.test, max, in ${dir}, pinned by providers[0].claude.config_dir`,
    ])
  })

  it('says when the token env wins over config_dir', async () => {
    const env = { CLAUDE_CODE_OAUTH_TOKEN: 't' }
    const [pin] = await pinLogins(
      withProvider('claude: { config_dir: /nowhere }'),
      env,
      recorded([]),
    )
    expect(await providerLogin(claude, pin, env)).toEqual([
      'ok',
      'claude login',
      'CLAUDE_CODE_OAUTH_TOKEN, which wins over providers[0].claude.config_dir',
    ])
  })

  it("fails with the fix when the pinned folder isn't logged in or is gone, never making it", async () => {
    const dir = await folder()
    const env: NodeJS.ProcessEnv = {}
    const [pin] = await pinLogins(withProvider(`claude: { config_dir: ${dir} }`), env, recorded([]))
    const real = claudeProvider(fake('claude'))
    expect(await providerLogin(real, pin, { ...env, PATH: process.env.PATH })).toEqual([
      'FAIL',
      'claude login',
      `no login in ${dir}, pinned by providers[0].claude.config_dir; log in with CLAUDE_CONFIG_DIR=${dir} claude /login`,
    ])
    account.mockClear()
    expect(
      await providerLogin(claude, undefined, { CLAUDE_CONFIG_DIR: join(dir, 'gone') }),
    ).toEqual([
      'FAIL',
      'claude login',
      `${join(dir, 'gone')} doesn't exist; log in with CLAUDE_CONFIG_DIR=${join(dir, 'gone')} claude /login`,
    ])
    expect(account).not.toHaveBeenCalled()
  })

  it("reads Claude's account, an email or the login method, and Codex's status line", async () => {
    const auth = (status: object) => ({
      PATH: process.env.PATH,
      FAKE_CLAUDE_AUTH: JSON.stringify(status),
    })
    const real = claudeProvider(fake('claude'))
    expect(
      await real.account?.(
        auth({ loggedIn: true, email: 'dev@example.test', subscriptionType: 'max' }),
      ),
    ).toBe('dev@example.test, max')
    expect(
      await real.account?.(
        auth({ loggedIn: true, email: null, authMethod: 'claude.ai', subscriptionType: 'team' }),
      ),
    ).toBe('claude.ai, team')
    await expect(real.account?.(auth({ loggedIn: false }))).rejects.toThrow('not logged in')
    const home = await folder()
    const codex = codexProvider(fake('codex'))
    const env = { PATH: process.env.PATH, CODEX_HOME: home }
    await expect(codex.account?.(env)).rejects.toThrow('Not logged in')
    await writeFile(join(home, 'auth.json'), '{}')
    expect(await codex.account?.(env)).toBe('Logged in using ChatGPT')
  })

  it("names gh's login and warns when the environment's isn't the pinned user", async () => {
    const env: NodeJS.ProcessEnv = {}
    const [pin] = await pinLogins(
      github('user: octocat'),
      env,
      recorded([[/auth token/, 'gho_octocat']]),
    )
    expect(ghLogin('octocat', 'octocat', pin, env)).toEqual([
      'ok',
      'gh login',
      'octocat, pinned by forge.github.user',
    ])
    const actions = { GH_TOKEN: 'ghp' }
    const [wins] = await pinLogins(github('user: octocat'), actions, recorded([]))
    expect(ghLogin('hubot', 'octocat', wins, actions)).toEqual([
      'warn',
      'gh login',
      "hubot from GH_TOKEN, not forge.github.user octocat: a token in the environment wins; make it octocat's, or unset it",
    ])
    expect(ghLogin('octocat', 'octocat', wins, actions)[2]).toBe('octocat, from GH_TOKEN')
    expect(ghLogin('hubot', undefined, undefined, {})[2]).toBe("hubot, gh's active account")
  })

  it("doesn't offer a pinned token as a repository secret", async () => {
    const env: NodeJS.ProcessEnv = { CLAUDE_CODE_OAUTH_TOKEN: 'c' }
    await pinLogins(github('user: octocat'), env, recorded([[/auth token/, 'gho_octocat']]))
    const asked: string[] = []
    const ask = {
      confirm: async (q: string) => asked.push(q) > 0,
      note: () => {},
    } as unknown as Ask
    const unset = await offerSecrets(
      ['GH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN'],
      env,
      ask,
      async () => {},
    )
    expect(unset).toEqual(['GH_TOKEN'])
    expect(asked).toEqual(['Set the CLAUDE_CODE_OAUTH_TOKEN repository secret from your env?'])
  })
})
