import { mkdir, mkdtemp, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { loadSkills } from '../src/config/skills.js'
import { assemblePrompt } from '../src/core/prompt.js'
import { builtinSkills, parseSkill, resolveSkill } from '../src/core/skills.js'

describe('skills', () => {
  it('looks up user, then in-repo, then built-in skills', () => {
    const catalog = {
      user: { review: { deliver: 'draft_pr' as const } },
      repo: { review: {}, fix: {} },
      builtin: builtinSkills,
    }
    expect(resolveSkill('review', catalog)).toEqual({
      origin: 'user',
      meta: { deliver: 'draft_pr' },
    })
    expect(resolveSkill('fix', catalog)?.origin).toBe('repo')
    expect(resolveSkill('plan', catalog)).toEqual({
      origin: 'builtin',
      meta: { deliver: 'report' },
    })
    expect(resolveSkill('nope', catalog)).toBeUndefined()
  })

  it('reads the delivery default from frontmatter metadata', () => {
    expect(parseSkill('---\nname: x\nmetadata:\n  deliver: report\n---\nbody')).toEqual({
      deliver: 'report',
    })
    expect(parseSkill('---\nname: x\nmetadata:\n  deliver: push\n---\n')).toEqual({})
    expect(parseSkill('no frontmatter')).toEqual({})
  })

  it('loads a skills dir, linked skills included, and tolerates a missing one', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'awaywork-skills-'))
    await mkdir(join(dir, 'triage'))
    await writeFile(join(dir, 'triage', 'SKILL.md'), '---\nmetadata: { deliver: report }\n---\n')
    await mkdir(join(dir, 'not-a-skill'))
    await writeFile(join(dir, 'notes.md'), 'not a skill either')
    const elsewhere = await mkdtemp(join(tmpdir(), 'awaywork-elsewhere-'))
    await writeFile(join(elsewhere, 'SKILL.md'), '---\ndescription: Linked.\n---\n')
    await symlink(elsewhere, join(dir, 'linked'))
    expect(await loadSkills(dir)).toEqual({
      triage: { deliver: 'report' },
      linked: { description: 'Linked.' },
    })
    expect(await loadSkills(join(dir, 'missing'))).toEqual({})
  })
})

describe('prompt', () => {
  it('keeps the fixed order and drops empty parts', () => {
    const prompt = assemblePrompt({
      harness: 'HARNESS',
      skill: 'SKILL',
      instructions: ['GLOBAL'],
      repo: { setup: 'pnpm i', test: 'pnpm vitest run {files}', instructions: 'REPO' },
      inRepo: 'IN-REPO',
      rule: ['RULE'],
    })
    expect(prompt.split('\n\n---\n\n')).toEqual([
      'HARNESS',
      'SKILL',
      'GLOBAL',
      'Setup, already run: `pnpm i`\nTest: `pnpm vitest run {files}`',
      'REPO',
      'IN-REPO',
      'RULE',
    ])
    expect(assemblePrompt({ harness: 'H', skill: 'S', instructions: [], repo: {}, rule: [] })).toBe(
      'H\n\n---\n\nS',
    )
  })

  it("lists a rule's parameters after the skill", () => {
    const prompt = assemblePrompt({
      harness: 'H',
      skill: 'S',
      params: { depth: 'quick', max_files: 5, strict: true },
      instructions: [],
      repo: {},
      rule: [],
    })
    expect(prompt.split('\n\n---\n\n')).toEqual([
      'H',
      'S',
      '## Parameters\n\n- depth: quick\n- max_files: 5\n- strict: true',
    ])
  })

  it('quotes a multi-line parameter so it stays in the list', () => {
    const prompt = assemblePrompt({
      harness: 'H',
      skill: 'S',
      params: { note: 'line one\n## Rogue\n' },
      instructions: [],
      repo: {},
      rule: [],
    })
    expect(prompt.split('\n\n---\n\n')[2]).toBe('## Parameters\n\n- note: "line one\\n## Rogue\\n"')
  })
})
