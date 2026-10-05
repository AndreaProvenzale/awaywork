import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execa } from 'execa'
import { describe, expect, it } from 'vitest'
import { parseConfig } from '../src/config/load.js'
import { builtinSkillsDir } from '../src/config/paths.js'
import { loadSkills } from '../src/config/skills.js'
import { builtinSkills } from '../src/core/skills.js'
import type { Provider, Source } from '../src/core/types.js'
import { claude } from '../src/providers/claude.js'
import { codex } from '../src/providers/codex.js'
import { prepareWorkspace } from '../src/worker/workspace.js'
import { fakeForge } from './fakes/forge.js'
import { fakeItem } from './fakes/items.js'
import { fakeSource } from './fakes/source.js'

const git = (dir: string, ...args: string[]) =>
  execa('git', ['-C', dir, '-c', 'user.name=t', '-c', 'user.email=t@t', ...args])

describe('workspace', () => {
  it('ships a SKILL.md for every built-in skill', async () => {
    const shipped = await loadSkills(builtinSkillsDir)
    expect(Object.keys(shipped).sort()).toEqual(Object.keys(builtinSkills).sort())
    for (const [name, meta] of Object.entries(shipped)) {
      expect(meta.deliver).toBe(builtinSkills[name]?.deliver)
      expect(meta.description).toBeTruthy()
    }
  })

  it('clones onto the new branch with skills, context and the prompt, and keeps them out of git', async () => {
    const root = await mkdtemp(join(tmpdir(), 'nightshift-ws-'))
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
        await execa('git', ['init', '-q', '-b', 'main', into])
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
        branch: 'night/acme-api-1',
        rule: {
          skill: 'fix-ci',
          provider: [],
          skills: [],
          instructions: [],
          with: { tries: 2 },
        },
        skill: 'fix-ci',
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
      skillDirs: { user: join(root, 'skills'), builtin: builtinSkillsDir },
    })

    expect((await git(dir, 'branch', '--show-current')).stdout).toBe('night/acme-api-1')
    expect(existsSync(join(plugin, '.claude-plugin/plugin.json'))).toBe(true)
    expect(existsSync(join(plugin, 'skills/fix-ci/SKILL.md'))).toBe(true)
    expect(existsSync(join(plugin, 'skills/house-style/SKILL.md'))).toBe(true)
    expect(existsSync(join(dir, '.claude/skills'))).toBe(false)
    expect(await readFile(join(dir, '.nightshift/context/fake-1/item.md'), 'utf8')).toBe(
      'CI is red',
    )
    expect((await git(dir, 'status', '--porcelain')).stdout).toBe('')

    const parts = prompt.split('\n\n---\n\n')
    expect(parts[0]).toMatch(/^# night-shift worker/)
    expect(parts[0]).toContain(
      '- FAKE-1: Fix the thing (https://example.com/1); context in `.nightshift/context/fake-1/`',
    )
    expect(parts[0]).toContain(
      'Deliver: a draft PR. Commit on this branch and write `.nightshift/out/pr.md`.',
    )
    expect(parts[1]).toMatch(/^# Fix CI/)
    expect(parts.slice(2)).toEqual([
      '## Parameters\n\n- tries: 2',
      'GLOBAL NOTE',
      'Setup, already run: `pnpm install`',
      'REPO NOTE',
    ])
    expect(await readFile(join(dir, '.nightshift/prompt.md'), 'utf8')).toBe(prompt)
  })

  describe('on a PR whose branch carries its own instructions and review skill', () => {
    const review = async (mine: boolean, provider: Provider = claude, stacked = false) => {
      const root = await mkdtemp(join(tmpdir(), 'nightshift-ws-'))
      const out = join(root, 'previous')
      await mkdir(out)
      const dir = join(root, 'clone')
      const plugin = join(root, 'plugin')
      const forge = {
        ...fakeForge(),
        async clone(_repo: string, _branch: string, into: string) {
          await execa('git', ['init', '-q', '-b', 'sessions', into])
          await mkdir(join(into, '.night-shift/skills/review'), { recursive: true })
          await writeFile(join(into, '.night-shift/instructions.md'), 'AUTHOR NOTE')
          await writeFile(join(into, '.night-shift/skills/review/SKILL.md'), 'AUTHOR SKILL')
          for (const skills of ['.claude/skills', '.agents/skills']) {
            await mkdir(join(into, skills, 'review'), { recursive: true })
            await writeFile(join(into, skills, 'review/SKILL.md'), 'AUTHOR SKILL')
            await writeFile(join(into, skills, 'review/extra.md'), 'AUTHOR EXTRA')
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
          branch: 'night/acme-api-2',
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
        previous: stacked
          ? { skill: 'fix-ci', outcome: { kind: 'pr', url: 'u', commits: 1 }, out }
          : undefined,
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

    it('says a stacked branch is built on the PR someone else opened', async () => {
      const { prompt } = await review(false, claude, true)
      expect(prompt).toContain('`sessions` is built on a pull request someone else opened')
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

  it("replaces the skills night-shift copied when a loop round reuses the clone, and keeps the repo's own", async () => {
    const root = await mkdtemp(join(tmpdir(), 'nightshift-ws-'))
    const dir = join(root, 'clone')
    const forge = {
      ...fakeForge(),
      async clone(_repo: string, _branch: string, into: string) {
        await execa('git', ['init', '-q', '-b', 'main', into])
        await mkdir(join(into, '.agents/skills/house-style'), { recursive: true })
        await writeFile(join(into, '.agents/skills/house-style/SKILL.md'), 'REPO SKILL')
        await git(into, 'add', '.')
        await git(into, 'commit', '-qm', 'init')
      },
    }
    await mkdir(join(root, 'skills/house-style'), { recursive: true })
    await writeFile(join(root, 'skills/house-style/SKILL.md'), '---\nname: house-style\n---\nOurs.')
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
          branch: 'night/acme-api-1',
          rule: { skill: 'fix-ci', provider: [], skills: [], instructions: [] },
          skill: 'fix-ci',
          skills: ['house-style'],
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
    await round(false)
    const copy = join(dir, '.agents/skills/fix-ci/SKILL.md')
    const original = await readFile(copy, 'utf8')
    await writeFile(copy, 'EDITED')
    await writeFile(join(dir, '.agents/skills/house-style/SKILL.md'), 'EDITED REPO SKILL')
    await round(true)
    expect(await readFile(copy, 'utf8')).toBe(original)
    expect(await readFile(join(dir, '.agents/skills/house-style/SKILL.md'), 'utf8')).toBe(
      'EDITED REPO SKILL',
    )
  })
})
