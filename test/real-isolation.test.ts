import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { execa } from 'execa'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { type Allowance, MAX_TURNS } from '../src/core/budget.js'
import {
  asWorker,
  isolate,
  launch,
  lostToWorker,
  WORKER,
  workerFor,
  workerHome,
  workerRoot,
} from '../src/core/launch.js'
import type { Job } from '../src/core/types.js'
import { codexProvider } from '../src/providers/codex.js'
import { commandProvider } from '../src/providers/command.js'
import { commitsSince, createChecks, head } from '../src/worker/checks.js'
import { runWorker } from '../src/worker/run.js'
import { runCommand } from '../src/worker/setup.js'
import { restoreGitConfig } from '../src/worker/workspace.js'

const CANARY = 'canary-4f2a9c'
const env = {
  PATH: process.env.PATH,
  HOME: process.env.HOME,
  XDG_CONFIG_HOME: `${process.env.HOME}/.config`,
  CANARY,
  AWAYWORK_PARENT: `${process.pid}`,
}
const leftover = async () => (await execa('pgrep', ['-u', WORKER], { reject: false })).stdout
const owner = async (path: string) => (await stat(path)).uid
const allowance: Allowance = { kind: 'fallback', units: 1, turns: MAX_TURNS, reason: 'test' }

/** Linux with the worker user and the sudo `awaywork doctor` asks for (or a hosted runner after `action.yml`); run with AWAYWORK_WORKER_TEST=1. */
describe.skipIf(!process.env.AWAYWORK_WORKER_TEST)('isolation user, live', () => {
  let dir: string
  beforeAll(async () => {
    expect(await workerFor('user', process.env)).toBe(WORKER)
    dir = await workerRoot()
    await execa('git', ['init', '-q', dir])
    isolate(WORKER)
  })
  afterAll(() => isolate(undefined))

  it('runs a command as the worker, with the env but none of its values on argv', async () => {
    const leaks = [
      'id -un; echo "$HOME $CANARY ${XDG_CONFIG_HOME-unset}"',
      // Builtins only: an exec'd command would carry the value on its own argv. A process can exit before its read.
      'for f in /proc/[0-9]*/cmdline; do c=$(tr "\\0" " " 2>/dev/null < $f); case "$c" in *"$CANARY"*) echo "argv: $f $c";; esac; done',
      'cat /proc/$AWAYWORK_PARENT/environ >/dev/null 2>&1 && echo "environ readable"',
      'echo out > out.txt',
      'ln -s /etc/hostname link',
    ]
    const result = await runCommand(leaks.join('\n'), dir, env, { secrets: [] })
    expect(result.output).toBe(`${WORKER}\n${workerHome(dir)} ${CANARY} unset`)
    expect(await owner(join(dir, 'out.txt'))).toBe(process.getuid?.())
    expect(await owner(dir)).toBe(process.getuid?.())
    expect(await owner('/etc/hostname')).toBe(0)
  })

  it('stops a check that hangs and detaches, and leaves no process behind', async () => {
    const started = Date.now()
    const result = await runCommand('setsid sleep 300 & sleep 300', dir, env, {
      secrets: [],
      timeoutMs: 2000,
    })
    expect(result.timedOut).toBe(true)
    expect(Date.now() - started).toBeLessThan(10_000)
    expect(await leftover()).toBe('')
  })

  it('reaps what setup leaves running once it exits', async () => {
    const started = Date.now()
    expect((await runCommand('sleep 300 & echo started', dir, env, { secrets: [] })).output).toBe(
      'started',
    )
    expect(Date.now() - started).toBeLessThan(10_000)
    expect(await leftover()).toBe('')
  })

  it('stops an agent that ignores SIGTERM at the window’s end', async () => {
    await writeFile(join(dir, 'agent.sh'), "trap '' TERM; setsid sleep 300 & sleep 300\n")
    const agent = commandProvider('mine', {
      command: 'sh agent.sh',
      secrets: [],
      skills_dir: '.agents/skills',
    })
    const job = { dir, prompt: '', maxTurns: 1, env, unit: {} } as unknown as Job
    const started = Date.now()
    const result = await runWorker(agent, job, allowance, {
      log: () => {},
      until: new Date(Date.now() + 2000),
    })
    expect(result.status).toBe('stopped: window ended')
    expect(Date.now() - started).toBeLessThan(15_000)
    expect(await leftover()).toBe('')
    expect(await owner(join(dir, 'agent.sh'))).toBe(process.getuid?.())
    // chown never followed the link the first test planted, either way.
    expect(await owner('/etc/hostname')).toBe(0)
  })

  it('loses a clone or home the worker swapped for a link to a folder of yours, or a folder of its own', async () => {
    const yours = await mkdtemp(join(homedir(), 'awaywork-yours-'))
    await execa('git', ['init', '-q', yours])
    const config = await readFile(join(yours, '.git', 'config'), 'utf8')
    for (const swap of [`ln -s ${yours} "$f"`, 'mkdir "$f"'])
      for (const f of ['$PWD', '$HOME']) {
        const clone = await workerRoot()
        await execa('git', ['init', '-q', clone])
        const phase = runCommand(`f=${f}; cd / && mv "$f" "$f.moved" && ${swap}`, clone, env, {
          secrets: [],
        })
        await expect(phase).rejects.toThrow("isn't the folder handed to the worker")
        expect(lostToWorker(clone)).toBe(true)
        // Nothing of the chain's runs in it again.
        await expect(runCommand('true', clone, env, { secrets: [] })).rejects.toThrow('lost')
        const home = workerHome(clone)
        const left = [clone, `${clone}.moved`, `${home}`, `${home}.moved`]
        await execa('sudo', ['-n', '-u', WORKER, 'rm', '-rf', ...left], { reject: false })
      }
    expect(await readFile(join(yours, '.git', 'config'), 'utf8')).toBe(config)
    await rm(yours, { recursive: true })
  })

  it('leaves no folder of a clone or its home that another user can write', async () => {
    const clone = await workerRoot()
    const open = 'mkdir -p sub/.git ~/.config && chmod 777 . sub sub/.git ~ ~/.config'
    expect((await runCommand(open, clone, env, { secrets: [] })).failed).toBeUndefined()
    const home = workerHome(clone) as string
    for (const path of [clone, `${clone}/sub/.git`, home, `${home}/.config`]) {
      expect((await stat(path)).mode & 0o066).toBe(0)
      const other = await execa('sudo', ['-n', '-u', WORKER, 'touch', `${path}/x`], {
        reject: false,
      })
      expect(other.stderr).toContain('Permission denied')
    }
  })

  it('closes a fresh clone to others before its first phase', async () => {
    const clone = await workerRoot()
    await writeFile(join(clone, 'README'), 'hi\n', { mode: 0o644 })
    await mkdir(join(clone, 'src'), { mode: 0o755 })
    const paths = [clone, join(clone, 'README'), join(clone, 'src')]
    const modes = await asWorker(clone, () =>
      Promise.all(paths.map(async (path) => (await stat(path)).mode & 0o777)),
    )
    expect(modes).toEqual([0o711, 0o600, 0o700])
  })

  it('gives each clone a HOME of its own', async () => {
    const [a, b] = [await workerRoot(), await workerRoot()]
    const plant = 'echo "$HOME" && echo registry=https://evil.example > ~/.npmrc'
    const first = await runCommand(plant, a, env, { secrets: [] })
    const second = await runCommand('echo "$HOME" && cat ~/.npmrc', b, env, { secrets: [] })
    expect(first.output).toBe(workerHome(a))
    expect(second.output).toMatch(new RegExp(`^${workerHome(b)}\\n.*No such file`))
    expect(workerHome(a)).toMatch(/^\/tmp\/awaywork-[A-Za-z0-9]{6}$/)
    expect(workerHome(a)).not.toBe(workerHome(b))
    expect(await owner(workerHome(a) as string)).toBe(process.getuid?.())
  })

  it('lends the Codex login to the worker’s HOME and saves its refresh back', async () => {
    const yours = await mkdtemp(join(homedir(), 'awaywork-codex-'))
    const authFile = join(yours, 'auth.json')
    const auth = (refresh: string) =>
      JSON.stringify({ tokens: { refresh_token: refresh, account_id: 'acct' } })
    await writeFile(authFile, auth('r0'))
    const codex = codexProvider('codex', join(yours, 'codex.lock'), authFile)
    const clone = await workerRoot()
    const refresh = `id -un && cat ~/.codex/auth.json && printf '%s' '${auth('r1')}' > ~/.codex/auth.json`
    const phase = () =>
      launch('/bin/sh', ['-c', refresh], { cwd: clone, env, extendEnv: false, reject: false })
    const ran = await asWorker(clone, phase, codex.login)
    expect(ran.stdout).toBe(`${WORKER}\n${auth('r0')}`)
    expect(await readFile(authFile, 'utf8')).toBe(auth('r1'))
    expect(existsSync(join(workerHome(clone) as string, '.codex'))).toBe(false)

    const fifo = () =>
      launch('/bin/sh', ['-c', 'rm ~/.codex/auth.json && mkfifo ~/.codex/auth.json'], {
        cwd: clone,
        env,
        extendEnv: false,
      })
    await asWorker(clone, fifo, codex.login)
    expect(existsSync(join(yours, 'codex.lock'))).toBe(false)
    expect(await readFile(authFile, 'utf8')).toBe(auth('r1'))
    await rm(yours, { recursive: true })
  })

  it('never takes a repo the worker planted in /tmp for the clone’s', async () => {
    expect(existsSync('/tmp/.git')).toBe(false)
    const clone = await workerRoot()
    await execa('git', ['init', '-q', clone])
    const commit = ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty']
    await execa('git', ['-C', clone, ...commit, '-m', 'start'])
    // As on the hosted image, whose /etc/gitconfig trusts every repo.
    const trustAll = {
      GIT_CONFIG_COUNT: '1',
      GIT_CONFIG_KEY_0: 'safe.directory',
      GIT_CONFIG_VALUE_0: '*',
    }
    Object.assign(process.env, trustAll)
    try {
      const plant = 'cp -R .git /tmp/.git && chmod -R a+rX /tmp/.git && rm .git/HEAD'
      const planted = await runCommand(plant, clone, env, { secrets: [] })
      expect(planted.failed).toBeUndefined()
      expect(existsSync('/tmp/.git/HEAD')).toBe(true)
      await restoreGitConfig(clone, '')
      await expect(head(clone)).rejects.toThrow("not a git repository: '.git'")
    } finally {
      for (const name of Object.keys(trustAll)) delete process.env[name]
      await execa('sudo', ['-n', '-u', WORKER, 'rm', '-rf', '/tmp/.git'])
    }
  })

  it('runs no git in a clone whose .git the worker linked to a repo of its own', async () => {
    const clone = await workerRoot()
    await execa('git', ['init', '-q', clone])
    const commit = ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty']
    await execa('git', ['-C', clone, ...commit, '-m', 'start'])
    const start = await head(clone)
    // A partial clone whose promisor "fetch" logs who ran it, with which token.
    const phase = [
      'r=/tmp/awaywork-linked && rm -rf $r && mkdir -m 777 $r',
      `printf '#!/bin/sh\\necho "$(id -un) GH_TOKEN=$GH_TOKEN" >> '$r'/log\\nexit 1\\n' > $r/cmd && chmod 755 $r/cmd`,
      `git init -q $r/repo && git -C $r/repo ${commit.join(' ')} -m w`,
      'git -C $r/repo config core.repositoryformatversion 1 && git -C $r/repo config extensions.partialClone origin',
      'git -C $r/repo config remote.origin.promisor true && git -C $r/repo config remote.origin.uploadpack $r/cmd',
      'chmod -R a+rwX $r/repo/.git && rm -rf .git && ln -s $r/repo/.git .git',
    ].join(' && ')
    process.env.GH_TOKEN = CANARY
    try {
      expect((await runCommand(phase, clone, env, { secrets: [] })).failed).toBeUndefined()
      await expect(restoreGitConfig(clone, '')).rejects.toThrow(
        '.git in the clone is not a directory',
      )
      const refused = await commitsSince(clone, start).catch((e: Error) => e.message)
      expect(await readFile('/tmp/awaywork-linked/log', 'utf8').catch(() => 'not run')).toBe(
        'not run',
      )
      expect(refused).toContain('no git in the clone')
    } finally {
      delete process.env.GH_TOKEN
      await execa('sudo', ['-n', '-u', WORKER, 'rm', '-rf', '/tmp/awaywork-linked'])
    }
  })

  it('runs no hook the worker left in .git/hooks when its git status writes the index', async () => {
    const clone = await workerRoot()
    await execa('git', ['init', '-q', clone])
    await writeFile(join(clone, 'README'), 'hi\n')
    await execa('git', ['-C', clone, 'add', 'README'])
    const commit = ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q']
    await execa('git', ['-C', clone, ...commit, '-m', 'start'])
    const config = await readFile(join(clone, '.git', 'config'), 'utf8')
    const phase = [
      'r=/tmp/awaywork-hooked && rm -rf $r && mkdir -m 777 $r',
      `printf '#!/bin/sh\\necho "$(id -un) GH_TOKEN=$GH_TOKEN" >> '$r'/log\\n' > .git/hooks/post-index-change`,
      'chmod 755 .git/hooks/post-index-change',
      // Stat-dirty, so `git status` refreshes the index and writes it.
      'touch -d @1000000000 README',
    ].join(' && ')
    process.env.GH_TOKEN = CANARY
    try {
      expect((await runCommand(phase, clone, env, { secrets: [] })).failed).toBeUndefined()
      await restoreGitConfig(clone, config)
      await createChecks({ env, secrets: [] }).baseline(clone)
      expect(await readFile('/tmp/awaywork-hooked/log', 'utf8').catch(() => 'not run')).toBe(
        'not run',
      )
    } finally {
      delete process.env.GH_TOKEN
      await execa('sudo', ['-n', '-u', WORKER, 'rm', '-rf', '/tmp/awaywork-hooked'])
    }
  })
})
