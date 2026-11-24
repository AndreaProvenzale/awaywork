import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { codexProvider } from '#providers/codex'
import { runCommand, runSetup, secretScan } from '#worker/process/command'
import { escaped, escaping } from './fakes/escape'

const env = { PATH: process.env.PATH, NPM_TOKEN: 'npm-secret' }
const alive = (pid: number) => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

describe('runSetup', () => {
  it('stops at the deadline even when a background process holds its output', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'awaywork-setup-'))
    const started = Date.now()
    const failed = await runSetup('sleep 30 & echo $! > pid; sleep 30', dir, env, () => {}, {
      secrets: [],
      until: new Date(Date.now() + 500),
    })
    expect(Date.now() - started).toBeLessThan(5000)
    expect(failed).toBe('setup failed: the window ended')
    expect(alive(Number(await readFile(join(dir, 'pid'), 'utf8')))).toBe(false)
  })

  it('stops what it started when it exits, and on an interrupt', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'awaywork-setup-'))
    expect(await runSetup('sleep 30 & echo $! > pid', dir, env, () => {}, { secrets: [] })).toBe(
      undefined,
    )
    expect(alive(Number(await readFile(join(dir, 'pid'), 'utf8')))).toBe(false)

    const abort = new AbortController()
    setTimeout(() => abort.abort(), 200)
    expect(
      await runSetup('sleep 30', dir, env, () => {}, { secrets: [], signal: abort.signal }),
    ).toBe('setup failed: interrupted')
  })

  it('masks its secrets in the log and the reason', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'awaywork-setup-'))
    const lines: string[] = []
    const failed = await runSetup(
      'echo "token $NPM_TOKEN"; exit 1',
      dir,
      env,
      (l) => lines.push(l),
      {
        secrets: ['NPM_TOKEN'],
      },
    )
    expect(lines).toEqual(['setup: token ***'])
    expect(failed).toMatch(/\ntoken \*\*\*$/)
  })
})

describe('runCommand', () => {
  it('marks a command that hit the time limit, not one stopped by the window end', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'awaywork-command-'))
    const real = AbortSignal.timeout.bind(AbortSignal)
    const spy = vi.spyOn(AbortSignal, 'timeout').mockImplementation(() => real(200))
    try {
      const result = await runCommand('sleep 30', dir, env, { secrets: [] })
      expect(result).toMatchObject({ failed: 'timed out after 15 min', timedOut: true })
      expect(result.stopped).toBeUndefined()
    } finally {
      spy.mockRestore()
    }
  })

  it('ends soon after a stop, whatever still holds its output', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'awaywork-command-'))
    const pid = join(dir, 'escaped.pid')
    const stop = new AbortController()
    const run = runCommand(`echo hi; ${escaping(pid)}; sleep 30`, dir, env, {
      secrets: [],
      signal: stop.signal,
    })
    await escaped(pid)
    stop.abort()
    const stopped = Date.now()
    try {
      expect(await run).toEqual({
        output: 'hi',
        stdout: 'hi',
        failed: 'interrupted',
        stopped: true,
      })
    } finally {
      process.kill(await escaped(pid), 'SIGKILL')
    }
    expect(Date.now() - stopped).toBeLessThan(5000)
  }, 30_000)
})

describe('secretScan', () => {
  const env = {
    LONG: 'sk-0123456789ab',
    SHORT: 'hunter2',
    EMPTY: '',
    GH_TOKEN: 'ghp_0123456789abcdef',
    TWG_BBC_TOKEN: 'bbc-0123456789ab',
    TWG_CONFIG_DIR: '/home/dev/.config/twg',
  }

  it('names the first secret whose value the text holds verbatim, passing over short and unset ones', async () => {
    const { leaked } = secretScan(['EMPTY', 'SHORT', 'UNSET', 'LONG'], {}, env)
    expect(await leaked('key sk-0123456789ab, pass hunter2')).toBe('LONG')
    expect(await leaked('pass hunter2')).toBeUndefined()
    expect(await leaked(Buffer.from('sk-0123456789ab').toString('base64'))).toBeUndefined()
  })

  it("looks for the forge's and twg's tokens too, not twg's config folder", async () => {
    const { leaked, mask } = secretScan([], {}, env)
    expect(await leaked('ghp_0123456789abcdef')).toBe('GH_TOKEN')
    expect(await leaked('bbc-0123456789ab')).toBe('TWG_BBC_TOKEN')
    expect(await leaked('/home/dev/.config/twg')).toBeUndefined()
    expect(await mask('a ghp_0123456789abcdef b')).toBe('a *** b')
  })

  it("looks for the Codex login's tokens, the rotated ones and those lent before", async () => {
    const auth = join(await mkdtemp(join(tmpdir(), 'awaywork-scan-')), 'auth.json')
    const login = (refresh_token: string) =>
      writeFile(auth, JSON.stringify({ tokens: { refresh_token, account_id: 'acct-0123456789' } }))
    await login('rt-old-0123456789')
    const { leaked } = secretScan([], { codex: codexProvider('codex', undefined, auth) }, {})
    expect(await leaked('rt-old-0123456789')).toBe('CODEX_LOGIN (refresh_token)')
    await login('rt-new-0123456789')
    expect(await leaked('rt-new-0123456789')).toBe('CODEX_LOGIN (refresh_token)')
    expect(await leaked('rt-old-0123456789')).toBe('CODEX_LOGIN (refresh_token)')
    expect(await leaked('acct-0123456789')).toBeUndefined()
  })
})
