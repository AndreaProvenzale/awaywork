// biome-ignore-all lint/suspicious/noTemplateCurlyInString: compose interpolation
import { existsSync } from 'node:fs'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { parse } from 'yaml'
import { REMOTE_PORT } from '../src/cli/remote.js'
import { installDocker } from '../src/cli/schedule.js'
import { packageVersion } from '../src/config/paths.js'
import { sudoersLines } from '../src/core/isolation.js'
import { DOCKER_FILES, removeDocker, staleDocker } from '../src/scheduler/docker.js'
import { REPO_CONFIG } from '../src/scheduler/github-actions.js'
import { initial, scriptedAsk } from './fakes/ask.js'

const template = (file: string) => readFile(new URL(`../docker/${file}`, import.meta.url), 'utf8')
const dockerfile = await template('Dockerfile')

afterEach(() => vi.restoreAllMocks())

it("gives the image's developer user the sudoers lines isolation: user asks for", () => {
  const uid = dockerfile.match(/useradd --uid (\d+) --gid away /)?.[1]
  const gid = dockerfile.match(/groupadd --gid (\d+) away/)?.[1]
  vi.spyOn(process, 'getuid').mockReturnValue(Number(uid))
  vi.spyOn(process, 'getgid').mockReturnValue(Number(gid))
  const sudoers = dockerfile.match(/<<"EOF" \/etc\/sudoers\.d\/awaywork\n([\s\S]*?)\nEOF\n/)?.[1]
  expect(sudoers).toBe(sudoersLines('away').join('\n'))
})

it('pins the awaywork version it ships in', () => {
  expect(dockerfile).toContain(`ARG AWAYWORK_VERSION=${packageVersion}\n`)
})

describe('schedule install --with docker', () => {
  let out: string[]
  beforeEach(() => {
    out = []
    vi.spyOn(console, 'log').mockImplementation((line) => void out.push(String(line)))
    vi.spyOn(console, 'error').mockImplementation((line) => void out.push(String(line)))
  })
  afterEach(() => {
    process.exitCode = undefined
  })

  const CONFIG = 'providers: [claude]\nsources: { github: { repos: [acme/api] } }\n'

  async function setup(text = CONFIG) {
    const root = await mkdtemp(join(tmpdir(), 'awaywork-repo-'))
    const config = join(await mkdtemp(join(tmpdir(), 'awaywork-home-')), 'config.yml')
    await writeFile(config, text)
    const install = async (script: [RegExp, unknown][] = [], interactive = false) => {
      out = []
      await installDocker(config, {
        run: async () => root,
        ask: scriptedAsk(script),
        env: {},
        setSecret: async () => {},
        interactive,
      })
    }
    const read = (file: string) => readFile(join(root, file), 'utf8')
    return { root, config, install, read }
  }

  it('writes the templates with only the version and packages pinned for a plain config, and copies the config', async () => {
    const { install, read } = await setup()
    await install()
    expect(await read('Dockerfile')).toBe(
      dockerfile.replace(/^ARG PACKAGES=(.*)$/m, 'ARG PACKAGES="$1"'),
    )
    expect(await read('entrypoint.sh')).toBe(await template('entrypoint.sh'))
    expect(await read(REPO_CONFIG)).toBe(CONFIG)
    expect(out).toEqual([
      'Wrote Dockerfile',
      'Wrote compose.yml',
      'Wrote entrypoint.sh',
      expect.stringMatching(/^Copied .*config\.yml to \.awaywork\/config\.yml$/),
      'Before the first run:',
      '  commit Dockerfile, compose.yml, entrypoint.sh and .awaywork/config.yml',
      '  set these env vars in Coolify, or in .env beside compose.yml on a VPS: GH_TOKEN, CLAUDE_CODE_OAUTH_TOKEN',
      expect.stringMatching(/^ {2}GH_TOKEN is a classic personal access token/),
    ])
    expect(process.exitCode).toBeUndefined()
    await install()
    expect(out.slice(0, 4)).toEqual([
      'Dockerfile is up to date',
      'compose.yml is up to date',
      'entrypoint.sh is up to date',
      '.awaywork/config.yml is up to date',
    ])
  })

  it("fits the files to the config: codex kept, cursor's installer as root, each secret and the timezone in compose", async () => {
    const { install, read } = await setup(`providers: [claude, codex, cursor]
sources:
  github: { repos: [acme/api] }
  board: { command: ./board, secrets: [BOARD_TOKEN], setup: "go build -o board ." }
repos: { acme/api: { secrets: [DATABASE_URL] } }
`)
    await install()
    expect(out.join('\n')).not.toMatch(/won't run/)
    expect(out).toContain(
      '  once it runs, log Codex in: docker exec -it <container> codex login --device-auth',
    )
    const built = await read('Dockerfile')
    expect(built).toContain('ARG PACKAGES="@anthropic-ai/claude-code @openai/codex"\n')
    const guide = await readFile(new URL('../docs/guide/scheduling.md', import.meta.url), 'utf8')
    const cursor = guide.match(/```dockerfile\n([\s\S]*?)```/)?.[1]?.replace(/^ {2}/gm, '')
    expect(cursor).toMatch(/^RUN install -d \/opt\/cursor/)
    expect(built).toContain(`as RUN lines: setup runs as the worker user.\n${cursor}`)
    expect(built).toContain(
      'COPY .awaywork /home/away/.awaywork\n# A command source\'s setup, in the config\'s folder, without the secrets.\nRUN <<"AWAYWORK_SETUP"\n#!/usr/bin/env bash\nset -eo pipefail\ncd /home/away/.awaywork\ngo build -o board .\nAWAYWORK_SETUP\n',
    )
    const { environment: env, expose } = parse(await read('compose.yml')).services.awaywork
    expect(expose).toEqual([String(REMOTE_PORT)])
    expect(env).toEqual({
      GH_TOKEN: '${GH_TOKEN:?}',
      CLAUDE_CODE_OAUTH_TOKEN: '${CLAUDE_CODE_OAUTH_TOKEN:-}',
      CURSOR_API_KEY: '${CURSOR_API_KEY:-}',
      BOARD_TOKEN: '${BOARD_TOKEN:-}',
      DATABASE_URL: '${DATABASE_URL:-}',
      TZ: `\${TZ:-${Intl.DateTimeFormat().resolvedOptions().timeZone}}`,
      AWAYWORK_REMOTE_TOKEN: '${AWAYWORK_REMOTE_TOKEN:-}',
    })
  })

  it('keeps a hand-edited Dockerfile without a terminal, shows the diff and exits 1; asks in one', async () => {
    const { root, install, read } = await setup()
    await install()
    const generated = await read('Dockerfile')
    const edited = generated.replace(
      /(as RUN lines: setup runs as the worker user\.\n)/,
      '$1RUN npm install -g pnpm@10\n',
    )
    await writeFile(join(root, 'Dockerfile'), edited)
    await install()
    expect(process.exitCode).toBe(1)
    expect(out.join('\n')).toContain('-RUN npm install -g pnpm@10')
    expect(out).toContain('Kept Dockerfile; run this again in a terminal to replace it')
    expect(await read('Dockerfile')).toBe(edited)
    process.exitCode = undefined
    await install([[/^Overwrite Dockerfile with the changes above\?$/, false]], true)
    expect(out).toContain('Kept Dockerfile')
    await install([[/^Overwrite Dockerfile/, initial]], true)
    expect(await read('Dockerfile')).toBe(generated)
    expect(out).toContain('  commit Dockerfile')
  })

  it('refuses a Bitbucket config and writes nothing', async () => {
    const { root, install } = await setup(
      'providers: [claude]\nsources: { bitbucket: { repos: [acme/api] } }\n',
    )
    await install()
    expect(process.exitCode).toBe(1)
    expect(out).toEqual([
      'A container runs only with the GitHub forge; schedule a Bitbucket config with launchd, systemd or cron',
    ])
    expect(existsSync(join(root, 'Dockerfile'))).toBe(false)
  })

  it('refuses a config that extends a base and writes nothing', async () => {
    const { root, config, install } = await setup()
    await writeFile(join(dirname(config), 'base.yml'), CONFIG)
    await writeFile(config, 'extends: base.yml\n')
    await install()
    expect(process.exitCode).toBe(1)
    expect(out).toEqual([
      `A container gets a copy of ${config} alone, without the base it extends; schedule a config with extends with launchd, systemd or cron`,
    ])
    expect(existsSync(join(root, 'Dockerfile'))).toBe(false)
  })

  it("removes its files, leaves a Dockerfile that isn't awaywork's, and warns about another version", async () => {
    const { root, install } = await setup()
    await install()
    expect(await staleDocker(root)).toBeUndefined()
    const file = join(root, 'Dockerfile')
    await writeFile(
      file,
      (await readFile(file, 'utf8')).replace(/AWAYWORK_VERSION=.*/, 'AWAYWORK_VERSION=0.0.1'),
    )
    expect(await staleDocker(root)).toBe(
      `Dockerfile builds awaywork 0.0.1, this is ${packageVersion}; run \`awaywork schedule install --with docker\` again to match`,
    )
    expect(await removeDocker(root)).toBe(true)
    for (const f of DOCKER_FILES) expect(existsSync(join(root, f))).toBe(false)
    expect(existsSync(join(root, REPO_CONFIG))).toBe(true)
    await writeFile(file, 'FROM alpine\n')
    expect(await removeDocker(root)).toBe(false)
    expect(await staleDocker(root)).toBeUndefined()
    expect(existsSync(file)).toBe(true)
  })
})
