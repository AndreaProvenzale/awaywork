import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { runSwitch } from '#cli/commands/switch'
import { readRegistry, resolveProfile, switchTo } from '#config/profiles'
import { servedRemotely } from '#run/remote'

const temp = () => mkdtemp(join(tmpdir(), 'awaywork-profiles-'))

async function registered(...names: string[]) {
  const dir = await temp()
  const registry = join(dir, 'profiles.yml')
  const configs: Record<string, string> = {}
  for (const name of names) {
    configs[name] = join(dir, `${name}.yml`)
    await writeFile(configs[name] as string, '')
    await switchTo(registry, name, configs[name])
  }
  return { dir, registry, configs }
}

describe('resolving the profile', () => {
  const registry = { current: 'work', profiles: { work: '/w.yml', play: '/p.yml' } }

  it('takes AWAYWORK_PROFILE over the registry, and the registry over the default', () => {
    expect(resolveProfile('play', registry)).toEqual({ name: 'play', config: '/p.yml' })
    expect(resolveProfile(undefined, registry)).toEqual({ name: 'work', config: '/w.yml' })
    expect(resolveProfile('', registry).name).toBe('work')
    expect(resolveProfile(undefined, { profiles: {} })).toEqual({ name: 'default' })
    expect(resolveProfile('default', registry)).toEqual({ name: 'default' })
  })

  it('falls back to the default, with the problem, for a name nobody registered', () => {
    const profile = resolveProfile('nope', registry)
    expect(profile.name).toBe('default')
    expect(profile.problem).toContain('awaywork switch nope <config>')
  })
})

describe('the registry', () => {
  it('is empty without a file', async () => {
    const dir = await temp()
    expect(readRegistry(join(dir, 'profiles.yml'))).toEqual({ current: undefined, profiles: {} })
  })

  it("refuses a file it can't read, naming it, and switch leaves it as it was", async () => {
    const path = join(await temp(), 'profiles.yml')
    const config = join(await temp(), 'c.yml')
    await writeFile(config, '')
    for (const text of [
      '{ not: [yaml',
      '- a\n- b\n',
      'current: work\nprofiles:\n  work: /w.yml\n   play: /p.yml\n',
      'profiles:\n  Bad_Name: /p.yml\n',
      'profiles:\n  work: [1]\n',
      'profiles: [work]\n',
    ]) {
      await writeFile(path, text)
      expect(() => readRegistry(path)).toThrow(path)
      await expect(switchTo(path, 'new', config)).rejects.toThrow(path)
      await expect(runSwitch(path, undefined)).rejects.toThrow(path)
      expect(await readFile(path, 'utf8')).toBe(text)
    }
  })

  it('drops the colon ending a yaml error line', async () => {
    const path = join(await temp(), 'profiles.yml')
    await writeFile(path, 'current: work\nprofiles:\n  work: /w.yml\n   play: /p.yml\n')
    expect(() => readRegistry(path)).toThrow(/column \d+$/)
  })

  it('reads a blank current as the default', async () => {
    const path = join(await temp(), 'profiles.yml')
    await writeFile(path, 'current:\n')
    expect(readRegistry(path)).toEqual({ current: undefined, profiles: {} })
  })

  it('keeps what switch registers and makes it current', async () => {
    const { registry, configs } = await registered('work', 'play')
    expect(readRegistry(registry)).toEqual({ current: 'play', profiles: configs })
    await switchTo(registry, 'work')
    expect(readRegistry(registry).current).toBe('work')
    await switchTo(registry, 'default')
    expect(readRegistry(registry).current).toBe('default')
  })

  it('refuses an unknown name, a bad name, a missing config and re-pointing default', async () => {
    const { dir, registry, configs } = await registered('work')
    await expect(switchTo(registry, 'nope')).rejects.toThrow('awaywork switch nope <config>')
    await expect(switchTo(registry, 'Bad_Name', configs.work)).rejects.toThrow(
      "isn't a profile name",
    )
    await expect(switchTo(registry, 'x', join(dir, 'gone.yml'))).rejects.toThrow("doesn't exist")
    await expect(switchTo(registry, 'default', configs.work)).rejects.toThrow('pick another name')
    expect(Object.keys(readRegistry(registry).profiles)).toEqual(['work'])
  })
})

describe('awaywork switch', () => {
  it("says when the current profile isn't registered", async () => {
    const path = join(await temp(), 'profiles.yml')
    await writeFile(path, 'current: gone\n')
    expect(await runSwitch(path, undefined)).toContain("current is gone, which isn't registered")
  })

  it('lists the profiles with the current one marked and where each config is', async () => {
    const { registry, configs } = await registered('work', 'play')
    await switchTo(registry, 'work')
    expect(await runSwitch(registry, undefined)).toBe(
      [
        '  default  ~/.config/awaywork/config.yml',
        `* work     ${configs.work}`,
        `  play     ${configs.play}`,
      ].join('\n'),
    )
  })

  it('switches, registers and says when AWAYWORK_PROFILE overrides', async () => {
    const { registry, configs } = await registered('work')
    expect(await runSwitch(registry, undefined, 'default')).toBe('Switched to default')
    expect(await runSwitch(registry, undefined, 'work')).toBe('Switched to work')
    expect(await runSwitch(registry, undefined, 'work', configs.work)).toBe('Switched to work')
    expect(await runSwitch(registry, 'default')).toContain(
      'AWAYWORK_PROFILE=default in this shell overrides',
    )
  })

  it("says when AWAYWORK_PROFILE isn't registered", async () => {
    const { registry } = await registered('work')
    expect(await runSwitch(registry, 'nope')).toContain(
      "AWAYWORK_PROFILE=nope in this shell isn't registered",
    )
  })

  it('never goes to AWAYWORK_REMOTE', () => {
    expect(servedRemotely(['switch'])).toBe(false)
    expect(servedRemotely(['switch', 'work'])).toBe(false)
  })
})

describe('where a profile keeps its files', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
    vi.resetModules()
  })

  async function pathsFor(home: string, profile?: string) {
    vi.stubEnv('HOME', home)
    vi.stubEnv('AWAYWORK_PROFILE', profile ?? '')
    vi.resetModules()
    return import('#config/paths')
  }

  it('is the old layout with no registry, reading the legacy env file only when there is no .env', async () => {
    const home = await temp()
    const config = join(home, '.config', 'awaywork')
    await mkdir(config, { recursive: true })
    let paths = await pathsFor(home)
    expect(paths.defaultConfigPath).toBe(join(config, 'config.yml'))
    expect(paths.stateDir).toBe(join(home, '.local', 'state', 'awaywork'))
    expect(paths.envFile).toBe(join(config, '.env'))
    await writeFile(join(config, 'env'), '')
    paths = await pathsFor(home)
    expect(paths.envFile).toBe(join(config, 'env'))
    await writeFile(join(config, '.env'), '')
    paths = await pathsFor(home)
    expect(paths.envFile).toBe(join(config, '.env'))
  })

  it('gives a named profile its config, the .env beside it and a state dir of its own', async () => {
    const home = await temp()
    const config = join(home, '.config', 'awaywork')
    const team = join(home, 'acme')
    await mkdir(config, { recursive: true })
    await mkdir(team)
    await writeFile(join(team, 'developer.yml'), '')
    await writeFile(join(config, 'env'), '')
    await switchTo(join(config, 'profiles.yml'), 'work', join(team, 'developer.yml'))
    const paths = await pathsFor(home)
    expect(paths.profile.name).toBe('work')
    expect(paths.defaultConfigPath).toBe(join(team, 'developer.yml'))
    expect(paths.envFile).toBe(join(team, '.env'))
    expect(paths.runsDir).toBe(
      join(home, '.local', 'state', 'awaywork', 'profiles', 'work', 'runs'),
    )
    expect(paths.rootStateDir).toBe(join(home, '.local', 'state', 'awaywork'))
    const forced = await pathsFor(home, 'default')
    expect(forced.defaultConfigPath).toBe(join(config, 'config.yml'))
    expect(await readFile(join(config, 'profiles.yml'), 'utf8')).toContain('current: work')
  })
})
