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
import type { Source } from '../src/core/types.js'
import { claude } from '../src/providers/claude.js'
import { prepareWorkspace } from '../src/worker/workspace.js'
import { fakeForge } from './fakes/forge.js'
import { fakeItem } from './fakes/items.js'
import { fakeSource } from './fakes/source.js'

const git = (dir: string, ...args: string[]) =>
  execa('git', ['-C', dir, '-c', 'user.name=t', '-c', 'user.email=t@t', ...args])

describe('workspace', () => {
  it('ships a SKILL.md for every built-in skill', async () => {
    expect(await loadSkills(builtinSkillsDir)).toEqual(builtinSkills)
  })

  it('clones onto the new branch with skills, context and the prompt, and keeps them out of git', async () => {
    const root = await mkdtemp(join(tmpdir(), 'nightshift-ws-'))
    const dir = join(root, 'clone')
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
        branch: 'night/acme-api-1',
        rule: { skill: 'fix-ci', where: {}, provider: [], skills: [], instructions: [] },
        skill: 'fix-ci',
        skills: ['house-style'],
        providers: ['claude'],
        instructions: [],
        deliver: 'draft_pr',
      },
      dir,
      config,
      configDir: root,
      forge,
      sources: { fake: fakeSource() as Source },
      provider: claude,
      ctx: { env: {}, log: () => {} },
      skillDirs: { user: join(root, 'skills'), builtin: builtinSkillsDir },
    })

    expect((await git(dir, 'branch', '--show-current')).stdout).toBe('night/acme-api-1')
    expect(existsSync(join(dir, '.claude/skills/fix-ci/SKILL.md'))).toBe(true)
    expect(existsSync(join(dir, '.claude/skills/house-style/SKILL.md'))).toBe(true)
    expect(await readFile(join(dir, '.nightshift/context/fake-1/FAKE-1.md'), 'utf8')).toBe(
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
    expect(parts.slice(2)).toEqual(['GLOBAL NOTE', 'Setup: `pnpm install`', 'REPO NOTE'])
    expect(await readFile(join(dir, '.nightshift/prompt.md'), 'utf8')).toBe(prompt)
  })
})
