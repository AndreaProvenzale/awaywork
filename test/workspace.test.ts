import { existsSync } from 'node:fs'
import {
  link,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rename,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { execa } from 'execa'
import { describe, expect, it } from 'vitest'
import { parseConfig } from '../src/config/load.js'
import { bin, builtinSkillsDir } from '../src/config/paths.js'
import { loadSkills } from '../src/config/skills.js'
import { builtinSkills } from '../src/core/skills.js'
import type { Provider, Source } from '../src/core/types.js'
import { claude } from '../src/providers/claude.js'
import { codex } from '../src/providers/codex.js'
import { prepareWorkspace, readOutput, writeOutput } from '../src/worker/workspace.js'
import { fakeForge } from './fakes/forge.js'
import { fakeItem } from './fakes/items.js'
import { fakeSource } from './fakes/source.js'

const git = (dir: string, ...args: string[]) =>
  execa(bin('git'), ['-C', dir, '-c', 'user.name=t', '-c', 'user.email=t@t', ...args])

describe('workspace', () => {
  it('ships a SKILL.md for every built-in skill', async () => {
    const shipped = await loadSkills(builtinSkillsDir)
    expect(Object.keys(shipped).sort()).toEqual(Object.keys(builtinSkills).sort())
    for (const [name, meta] of Object.entries(shipped)) {
      expect(meta.deliver).toBe(builtinSkills[name]?.deliver)
      expect(meta.description).toBeTruthy()
    }
  })

  it('clones onto the new branch with skills from beside the config, context and the prompt, and keeps them out of git', async () => {
    const root = await mkdtemp(join(tmpdir(), 'awaywork-ws-'))
    const dir = join(root, 'clone')
    const plugin = join(root, 'plugin')
    await mkdir(join(root, 'skills', 'house-style'), { recursive: true })
    await writeFile(
      join(root, 'skills', 'house-style', 'SKILL.md'),
      '---\nname: house-style\n---\nOurs.',
    )
    await writeFile(join(root, 'me.md'), 'GLOBAL NOTE')
    await writeFile(join(root, 'api.md'), 'REPO NOTE')
    const config = parseConfig(`
providers: [claude: {}]
sources: { github: { repos: [acme/*] } }
instructions: me.md
repos: { acme/api: { setup: pnpm install, instructions: api.md } }
`)
    const forge = {
      ...fakeForge(),
      async clone(_repo: string, _branch: string, into: string) {
        await mkdir(into)
        await execa(bin('git'), ['init', '-q', '-b', 'main', into])
        await writeFile(join(into, 'README.md'), 'hi')
        await git(into, 'add', '.')
        await git(into, 'commit', '-qm', 'init')
      },
    }
    const item = fakeItem({ description: 'CI is red' })

    const prompt = await prepareWorkspace({
      unit: {
        id: 'acme-api-1',
        items: [item],
        repo: 'acme/api',
        base: '',
        foreign: false,
        network: true,
        untrusted: false,
        branch: 'away/acme-api-1',
        rule: {
          skill: 'fix',
          provider: [],
          skills: [],
          instructions: [],
          with: { tries: 2 },
        },
        skill: 'fix',
        skills: ['house-style'],
        providers: ['claude'],
        instructions: [],
        deliver: 'draft_pr',
      },
      dir,
      plugin,
      config,
      configDir: root,
      forge,
      sources: { fake: fakeSource() as Source },
      provider: claude,
      ctx: { env: {}, log: () => {} },
    })

    expect((await git(dir, 'branch', '--show-current')).stdout).toBe('away/acme-api-1')
    expect(existsSync(join(plugin, '.claude-plugin/plugin.json'))).toBe(true)
    expect(existsSync(join(plugin, 'skills/fix/SKILL.md'))).toBe(true)
    expect(existsSync(join(plugin, 'skills/house-style/SKILL.md'))).toBe(true)
    expect(existsSync(join(dir, '.claude/skills'))).toBe(false)
    expect(await readFile(join(dir, '.away/context/fake-1/item.md'), 'utf8')).toBe('CI is red')
    expect((await git(dir, 'status', '--porcelain')).stdout).toBe('')

    const parts = prompt.split('\n\n---\n\n')
    expect(parts[0]).toMatch(/^# awaywork worker/)
    expect(parts[0]).toContain(
      '- FAKE-1: Fix the thing (https://example.com/1); context in `.away/context/fake-1/`',
    )
    expect(parts[0]).toContain(
      'Deliver: commits for a draft PR. Commit on this branch and write `.away/out/pr.md`, the PR body.',
    )
    expect(parts[1]).toMatch(/^# Fix\n/)
    expect(parts.slice(2)).toEqual([
      '## Parameters\n\n- tries: 2',
      'GLOBAL NOTE',
      'Setup, already run: `pnpm install`',
      'REPO NOTE',
    ])
    expect(await readFile(join(dir, '.away/prompt.md'), 'utf8')).toBe(prompt)
  })

  it('still reads a symlinked or hard-linked SKILL.md from the user skills dir', async () => {
    const root = await mkdtemp(join(tmpdir(), 'awaywork-ws-'))
    await mkdir(join(root, 'skills/linked'), { recursive: true })
    await writeFile(join(root, 'real.md'), '---\nname: linked\n---\nFollow the link.')
    await symlink(join(root, 'real.md'), join(root, 'skills/linked/SKILL.md'))
    await mkdir(join(root, 'skills/hard'), { recursive: true })
    await link(join(root, 'real.md'), join(root, 'skills/hard/SKILL.md'))
    for (const skill of ['linked', 'hard']) {
      const prompt = await prepareWorkspace({
        unit: {
          id: 'acme-api-1',
          items: [fakeItem()],
          repo: 'acme/api',
          base: '',
          foreign: false,
          network: true,
          untrusted: false,
          branch: 'away/acme-api-1',
          rule: { skill, provider: [], skills: [], instructions: [] },
          skill,
          skills: [],
          providers: ['claude'],
          instructions: [],
          deliver: 'draft_pr',
        },
        dir: join(root, `clone-${skill}`),
        plugin: join(root, `plugin-${skill}`),
        config: parseConfig('providers: [claude: {}]\nsources: { github: { repos: [acme/*] } }'),
        configDir: root,
        forge: {
          ...fakeForge(),
          async clone(_repo: string, _branch: string, into: string) {
            await mkdir(into)
            await execa(bin('git'), ['init', '-q', '-b', 'main', into])
            await writeFile(join(into, 'README.md'), 'hi')
            await git(into, 'add', '.')
            await git(into, 'commit', '-qm', 'init')
          },
        },
        sources: { fake: fakeSource() as Source },
        provider: claude,
        ctx: { env: {}, log: () => {} },
        skillDirs: { user: join(root, 'skills'), builtin: builtinSkillsDir },
      })
      expect(prompt).toContain('Follow the link.')
    }
  })

  it('copies a linked skill folder as a real folder, kept out of git', async () => {
    const root = await mkdtemp(join(tmpdir(), 'awaywork-ws-'))
    await mkdir(join(root, 'elsewhere/house-style'), { recursive: true })
    await writeFile(join(root, 'elsewhere/house-style/SKILL.md'), '---\nname: house-style\n---\n')
    await mkdir(join(root, 'skills'))
    await symlink(join(root, 'elsewhere/house-style'), join(root, 'skills/house-style'))
    for (const provider of [claude, codex]) {
      const dir = join(root, `clone-${provider.id}`)
      const plugin = join(root, `plugin-${provider.id}`)
      await prepareWorkspace({
        unit: {
          id: 'acme-api-1',
          items: [fakeItem()],
          repo: 'acme/api',
          base: '',
          foreign: false,
          network: true,
          untrusted: false,
          branch: 'away/acme-api-1',
          rule: { skill: 'fix', provider: [], skills: [], instructions: [] },
          skill: 'fix',
          skills: ['house-style'],
          providers: [provider.id],
          instructions: [],
          deliver: 'draft_pr',
        },
        dir,
        plugin,
        config: parseConfig(
          `providers: [${provider.id}: {}]\nsources: { github: { repos: [acme/*] } }`,
        ),
        configDir: root,
        forge: {
          ...fakeForge(),
          async clone(_repo: string, _branch: string, into: string) {
            await mkdir(into)
            await execa(bin('git'), ['init', '-q', '-b', 'main', into])
            await writeFile(join(into, 'README.md'), 'hi')
            await git(into, 'add', '.')
            await git(into, 'commit', '-qm', 'init')
          },
        },
        sources: { fake: fakeSource() as Source },
        provider,
        ctx: { env: {}, log: () => {} },
      })
      const copy =
        provider === claude
          ? join(plugin, 'skills/house-style')
          : join(dir, '.agents/skills/house-style')
      expect((await lstat(copy)).isDirectory()).toBe(true)
      expect((await git(dir, 'status', '--porcelain')).stdout).toBe('')
    }
  })

  describe("with skills in the repo's .claude/skills and .agents/skills", () => {
    /** `links` maps a path in the clone to a symlink target, in place of the skill folder there. */
    const prepare = async (
      provider: Provider,
      foreign = false,
      links: Record<string, string> = {},
    ) => {
      const root = await mkdtemp(join(tmpdir(), 'awaywork-ws-'))
      const dir = join(root, 'clone')
      await mkdir(join(root, 'outside'))
      await writeFile(join(root, 'outside/SKILL.md'), 'OUTSIDE')
      const plugin = join(root, 'plugin')
      const prompt = await prepareWorkspace({
        unit: {
          id: 'acme-api-1',
          items: [fakeItem()],
          repo: 'acme/api',
          base: '',
          foreign,
          network: true,
          untrusted: false,
          branch: 'away/acme-api-1',
          rule: { skill: 'fix', provider: [], skills: [], instructions: [] },
          skill: 'fix',
          skills: ['tdd', 'standard'],
          providers: [provider.id],
          instructions: [],
          deliver: 'draft_pr',
        },
        dir,
        plugin,
        config: parseConfig(
          `providers: [${provider.id}: {}]\nsources: { github: { repos: [acme/*] } }`,
        ),
        configDir: root,
        forge: {
          ...fakeForge(),
          async clone(_repo: string, _branch: string, into: string) {
            await execa(bin('git'), ['init', '-q', '-b', 'main', into])
            for (const [path, text] of Object.entries({
              '.claude/skills/fix': 'REPO FIX',
              '.claude/skills/tdd': 'REPO TDD',
              '.agents/skills/standard': 'REPO STANDARD',
            })) {
              if (path in links) continue
              await mkdir(join(into, path), { recursive: true })
              await writeFile(join(into, path, 'SKILL.md'), text)
            }
            for (const [path, target] of Object.entries(links)) {
              await mkdir(dirname(join(into, path)), { recursive: true })
              await symlink(target, join(into, path))
            }
            await git(into, 'add', '.')
            await git(into, 'commit', '-qm', 'init')
          },
        },
        sources: { fake: fakeSource() as Source },
        provider,
        ctx: { env: {}, log: () => {} },
        skillDirs: { user: join(root, 'skills'), builtin: builtinSkillsDir },
      })
      return { dir, plugin, prompt }
    }

    it('takes extra skills from them, never the main skill', async () => {
      const { plugin, prompt } = await prepare(claude)
      expect(prompt).not.toContain('REPO FIX')
      expect(await readFile(join(plugin, 'skills/fix/SKILL.md'), 'utf8')).toBe(
        await readFile(join(builtinSkillsDir, 'fix/SKILL.md'), 'utf8'),
      )
      expect(await readFile(join(plugin, 'skills/tdd/SKILL.md'), 'utf8')).toBe('REPO TDD')
      expect(await readFile(join(plugin, 'skills/standard/SKILL.md'), 'utf8')).toBe('REPO STANDARD')
    })

    it('gives Codex the .claude/skills ones in .agents/skills, kept out of git', async () => {
      const { dir } = await prepare(codex)
      expect(await readFile(join(dir, '.agents/skills/tdd/SKILL.md'), 'utf8')).toBe('REPO TDD')
      expect(await readFile(join(dir, '.agents/skills/standard/SKILL.md'), 'utf8')).toBe(
        'REPO STANDARD',
      )
      expect((await git(dir, 'status', '--porcelain')).stdout).toBe('')
    })

    it('ignores them on a PR someone else opened', async () => {
      await expect(prepare(claude, true)).rejects.toThrow('unknown skill "tdd"')
    })

    it('refuses a skill folder, or a file in one, linked out of the clone', async () => {
      for (const provider of [claude, codex]) {
        await expect(
          prepare(provider, false, { '.claude/skills/tdd': '../../../outside' }),
        ).rejects.toThrow('.claude/skills/tdd in the clone links outside it')
        await expect(
          prepare(provider, false, {
            '.claude/skills/tdd/notes.md': '../../../../outside/SKILL.md',
          }),
        ).rejects.toThrow('.claude/skills/tdd/notes.md in the clone links outside it')
      }
    })

    it('follows a link that stays in the clone', async () => {
      const { plugin } = await prepare(claude, false, {
        '.agents/skills/standard': '../../.claude/skills/tdd',
      })
      expect(await readFile(join(plugin, 'skills/standard/SKILL.md'), 'utf8')).toBe('REPO TDD')
    })
  })

  describe('on a PR whose branch carries its own instructions and review skill', () => {
    /** `agentsSkills`, when given, is where the branch's `.agents/skills` links to. */
    const review = async (mine: boolean, provider: Provider = claude, agentsSkills?: string) => {
      const root = await mkdtemp(join(tmpdir(), 'awaywork-ws-'))
      const dir = join(root, 'clone')
      const plugin = join(root, 'plugin')
      const forge = {
        ...fakeForge(),
        async clone(_repo: string, _branch: string, into: string) {
          await execa(bin('git'), ['init', '-q', '-b', 'sessions', into])
          await mkdir(join(into, '.awaywork/skills/review'), { recursive: true })
          await writeFile(join(into, '.awaywork/instructions.md'), 'AUTHOR NOTE')
          await writeFile(join(into, '.awaywork/skills/review/SKILL.md'), 'AUTHOR SKILL')
          for (const skills of ['.claude/skills', ...(agentsSkills ? [] : ['.agents/skills'])]) {
            await mkdir(join(into, skills, 'review'), { recursive: true })
            await writeFile(join(into, skills, 'review/SKILL.md'), 'AUTHOR SKILL')
            await writeFile(join(into, skills, 'review/extra.md'), 'AUTHOR EXTRA')
          }
          if (agentsSkills) {
            await mkdir(join(into, '.agents'))
            await symlink(agentsSkills, join(into, '.agents/skills'))
          }
          await git(into, 'add', '.')
          await git(into, 'commit', '-qm', 'init')
        },
      }
      const pr = {
        repo: 'acme/api',
        number: 2,
        url: 'u',
        branch: 'sessions',
        ours: false,
        mine,
        trusted: true,
        fork: false,
      }
      const prompt = await prepareWorkspace({
        unit: {
          id: 'acme-api-2',
          items: [fakeItem({ linkedPrs: [pr] })],
          repo: 'acme/api',
          base: 'sessions',
          foreign: !mine,
          network: true,
          untrusted: false,
          branch: 'away/acme-api-2',
          rule: { skill: 'review', provider: [], skills: [], instructions: [] },
          skill: 'review',
          skills: [],
          providers: ['claude'],
          instructions: [],
          deliver: 'report',
        },
        dir,
        plugin,
        config: parseConfig('providers: [claude: {}]\nsources: { github: { repos: [acme/*] } }'),
        configDir: root,
        forge,
        sources: { fake: fakeSource() as Source },
        provider,
        ctx: { env: {}, log: () => {} },
        skillDirs: { user: join(root, 'skills'), builtin: builtinSkillsDir },
      })
      return { dir, plugin, prompt }
    }
    const builtinReview = () => readFile(join(builtinSkillsDir, 'review/SKILL.md'), 'utf8')

    it("ignores them when someone else opened it and says the branch's files are the author's", async () => {
      const { dir, plugin, prompt } = await review(false)
      expect(prompt).not.toContain('AUTHOR')
      expect(prompt).toContain('`sessions` is a pull request someone else opened')
      expect(await readFile(join(plugin, 'skills/review/SKILL.md'), 'utf8')).toBe(
        await builtinReview(),
      )
      expect((await git(dir, 'status', '--porcelain')).stdout).toBe('')
    })

    it("replaces the author's copy in the clone for Codex and keeps it out of git", async () => {
      const { dir } = await review(false, codex)
      expect(await readFile(join(dir, '.agents/skills/review/SKILL.md'), 'utf8')).toBe(
        await builtinReview(),
      )
      expect(existsSync(join(dir, '.agents/skills/review/extra.md'))).toBe(false)
      expect((await git(dir, 'status', '--porcelain')).stdout).toBe('')
    })

    it('refuses to write through a linked .agents/skills that leaves the clone', async () => {
      const outside = await mkdtemp(join(tmpdir(), 'awaywork-outside-'))
      await mkdir(join(outside, 'review'))
      await writeFile(join(outside, 'review/SKILL.md'), 'OUTSIDE SKILL')
      await writeFile(join(outside, 'review/keep.txt'), 'KEEP')
      await expect(review(false, codex, outside)).rejects.toThrow(
        '.agents/skills in the clone links outside it',
      )
      expect(await readFile(join(outside, 'review/keep.txt'), 'utf8')).toBe('KEEP')
      expect(await readFile(join(outside, 'review/SKILL.md'), 'utf8')).toBe('OUTSIDE SKILL')
    })

    it('writes through a linked .agents/skills that stays in the clone', async () => {
      const { dir } = await review(false, codex, '../.claude/skills')
      expect(await readFile(join(dir, '.agents/skills/review/SKILL.md'), 'utf8')).toBe(
        await builtinReview(),
      )
      expect((await git(dir, 'status', '--porcelain')).stdout).toBe('')
    })

    it("keeps them on the developer's own PR", async () => {
      const { dir, plugin, prompt } = await review(true)
      expect(prompt).toContain('AUTHOR NOTE')
      expect(prompt).toContain('AUTHOR SKILL')
      expect(prompt).not.toContain('someone else opened')
      expect(await readFile(join(plugin, 'skills/review/SKILL.md'), 'utf8')).toBe('AUTHOR SKILL')
      expect(await readFile(join(dir, '.claude/skills/review/SKILL.md'), 'utf8')).toBe(
        'AUTHOR SKILL',
      )
      const own = await review(true, codex)
      expect(await readFile(join(own.dir, '.agents/skills/review/SKILL.md'), 'utf8')).toBe(
        'AUTHOR SKILL',
      )
    })
  })

  /** A Codex loop on one clone whose repo `commit` fills, with `skills` as the extra skills. */
  const codexLoop = async (skills: string[], commit: (into: string) => Promise<void>) => {
    const root = await mkdtemp(join(tmpdir(), 'awaywork-ws-'))
    const dir = join(root, 'clone')
    const forge = {
      ...fakeForge(),
      async clone(_repo: string, _branch: string, into: string) {
        await execa(bin('git'), ['init', '-q', '-b', 'main', into])
        await commit(into)
        await git(into, 'add', '.')
        await git(into, 'commit', '-qm', 'init')
      },
    }
    const round = (reuse: boolean) =>
      prepareWorkspace({
        unit: {
          id: 'acme-api-1',
          items: [fakeItem()],
          repo: 'acme/api',
          base: '',
          foreign: false,
          network: true,
          untrusted: false,
          branch: 'away/acme-api-1',
          rule: { skill: 'fix', provider: [], skills: [], instructions: [] },
          skill: 'fix',
          skills,
          providers: ['claude'],
          instructions: [],
          deliver: 'draft_pr',
        },
        dir,
        plugin: join(root, 'plugin'),
        config: parseConfig('providers: [claude: {}]\nsources: { github: { repos: [acme/*] } }'),
        configDir: root,
        forge,
        sources: { fake: fakeSource() as Source },
        provider: codex,
        ctx: { env: {}, log: () => {} },
        skillDirs: { user: join(root, 'skills'), builtin: builtinSkillsDir },
        reuse,
      })
    return { root, dir, round }
  }

  it("replaces the skills awaywork copied when a loop round reuses the clone, and keeps the repo's own", async () => {
    const { root, dir, round } = await codexLoop(['house-style'], async (into) => {
      await mkdir(join(into, '.agents/skills/house-style'), { recursive: true })
      await writeFile(join(into, '.agents/skills/house-style/SKILL.md'), 'REPO SKILL')
    })
    await mkdir(join(root, 'skills/house-style'), { recursive: true })
    await writeFile(join(root, 'skills/house-style/SKILL.md'), '---\nname: house-style\n---\nOurs.')
    await round(false)
    const copy = join(dir, '.agents/skills/fix/SKILL.md')
    const original = await readFile(copy, 'utf8')
    await writeFile(copy, 'EDITED')
    await writeFile(join(dir, '.agents/skills/house-style/SKILL.md'), 'EDITED REPO SKILL')
    await round(true)
    expect(await readFile(copy, 'utf8')).toBe(original)
    expect(await readFile(join(dir, '.agents/skills/house-style/SKILL.md'), 'utf8')).toBe(
      'EDITED REPO SKILL',
    )
  })

  it("keeps a skill the repo links in .agents/skills through a loop's rounds", async () => {
    const { dir, round } = await codexLoop(['standard'], async (into) => {
      await mkdir(join(into, '.claude/skills/tdd'), { recursive: true })
      await writeFile(join(into, '.claude/skills/tdd/SKILL.md'), 'REPO TDD')
      await mkdir(join(into, '.agents/skills'), { recursive: true })
      await symlink('../../.claude/skills/tdd', join(into, '.agents/skills/standard'))
    })
    await round(false)
    await round(true)
    expect((await lstat(join(dir, '.agents/skills/standard'))).isSymbolicLink()).toBe(true)
    expect(await readFile(join(dir, '.agents/skills/standard/SKILL.md'), 'utf8')).toBe('REPO TDD')
  })

  it("refuses a loop round when a worker linked awaywork's skill copy, or the folder holding it", async () => {
    const { root, dir, round } = await codexLoop([], (into) => writeFile(join(into, 'README'), ''))
    await round(false)
    const skills = join(dir, '.agents/skills')
    await mkdir(join(root, 'elsewhere'))
    await rm(join(skills, 'fix'), { recursive: true })
    await symlink(join(root, 'elsewhere'), join(skills, 'fix'))
    await expect(round(true)).rejects.toThrow('.agents/skills/fix in the clone is a symlink')
    await rename(skills, join(root, 'skills-elsewhere'))
    await symlink(join(root, 'skills-elsewhere'), skills)
    await expect(round(true)).rejects.toThrow('.agents/skills in the clone is a symlink')
    expect(await readdir(join(root, 'elsewhere'))).toEqual([])
  })

  it('refuses to write through a symlink or a hard link, leaving the target alone', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ns-out-'))
    const outside = join(dir, 'outside')
    await writeFile(outside, 'keep')
    await symlink(outside, join(dir, 'sym'))
    await link(outside, join(dir, 'hard'))
    await expect(writeOutput(join(dir, 'sym'), 'x')).rejects.toThrow()
    await expect(writeOutput(join(dir, 'hard'), 'x')).rejects.toThrow()
    expect(await readFile(outside, 'utf8')).toBe('keep')
    await writeOutput(join(dir, 'plain'), 'one')
    await writeOutput(join(dir, 'plain'), 'two')
    expect(await readFile(join(dir, 'plain'), 'utf8')).toBe('two')
  })

  it('reads nothing from a symlink or a hard link', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ns-out-'))
    const outside = join(dir, 'outside')
    await writeFile(outside, 'secret')
    await symlink(outside, join(dir, 'sym'))
    await link(outside, join(dir, 'hard'))
    expect(await readOutput(join(dir, 'sym'))).toBe('')
    expect(await readOutput(join(dir, 'hard'))).toBe('')
  })
})
