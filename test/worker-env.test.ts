import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { asWorker, useMode, workerHome } from '#core/isolation/index'
import { none } from '#core/isolation/none'
import { WORKER } from '#core/isolation/sudo'
import { userMode, workerEnvOf } from '#core/isolation/user'
import { launch } from '#core/launch'

// A file of its own: bin() keeps the first sudo it finds, here the fake one.
it('gives the worker user only the env it needs, none other in sudo’s own, and logs in each phase what it left out', async () => {
  // A sudo that records a launch's argv and its own env, and runs nothing.
  const fakes = await mkdtemp(join(tmpdir(), 'awaywork-sudo-'))
  const seen = join(fakes, 'seen')
  const sudo = `#!/bin/sh\ncase "$*" in *--preserve-env*) { echo "$*"; env; } >> ${seen};; esac\n`
  await writeFile(join(fakes, 'sudo'), sudo, { mode: 0o755 })
  const path = process.env.PATH
  process.env.PATH = `${fakes}:${path}`
  useMode(userMode(WORKER))
  const clone = await mkdtemp(join(tmpdir(), 'awaywork-clone-'))
  const lines: string[] = []
  const phase = {
    name: 'agent' as const,
    hosts: [],
    secrets: ['CLAUDE_CODE_OAUTH_TOKEN'],
    log: (line: string) => void lines.push(line),
  }
  const env = {
    PATH: '/usr/bin:/bin',
    LC_ALL: 'C.UTF-8',
    GH_TOKEN: 'none',
    CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-canary',
    NPM_TOKEN: 'npm-canary',
    AWS_SECRET_ACCESS_KEY: 'aws-canary',
  }
  const options = { cwd: clone, env, extendEnv: false, reject: false }
  let home: string | undefined
  try {
    const twice = async () => {
      await launch('agent', [], options)
      await launch('agent', [], { ...options, env: { ...env, JAVA_HOME: '/opt/java' } })
    }
    await asWorker(clone, twice, undefined, phase)
    await asWorker(clone, () => launch('agent', [], options), undefined, phase)
    home = workerHome(clone)
  } finally {
    useMode(none)
    process.env.PATH = path
    for (const folder of [clone, home])
      if (folder) await rm(folder, { recursive: true, force: true })
  }
  expect(lines).toEqual([
    'env: not passed to the worker user: AWS_SECRET_ACCESS_KEY, NPM_TOKEN',
    'env: not passed to the worker user: JAVA_HOME',
    'env: not passed to the worker user: AWS_SECRET_ACCESS_KEY, NPM_TOKEN',
  ])
  const recorded = await readFile(seen, 'utf8')
  expect(recorded).toContain('--preserve-env=PATH,LC_ALL,GH_TOKEN,CLAUDE_CODE_OAUTH_TOKEN ')
  expect(recorded).toContain('CLAUDE_CODE_OAUTH_TOKEN=sk-ant-canary')
  for (const value of ['npm-canary', 'aws-canary', '/opt/java'])
    expect(recorded).not.toContain(value)
  const host = { TZ: 'Europe/Rome', CI: 'true', HTTPS_PROXY: 'http://127.0.0.1:3128' }
  expect(workerEnvOf(host, [], false)).toEqual({
    env: { TZ: 'Europe/Rome', CI: 'true' },
    dropped: ['HTTPS_PROXY'],
  })
  expect(workerEnvOf(host, [], true)).toEqual({ env: host, dropped: [] })
})
