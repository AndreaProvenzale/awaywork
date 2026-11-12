import { mkdir, mkdtemp, readFile, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { formatRules, rulesJson } from '../src/cli/format/rules.js'
import { ejectSkill, listSkills, skillsJson } from '../src/cli/skills.js'
import { loadConfig, parseConfig } from '../src/config/load.js'
import { builtinSkillsDir } from '../src/config/paths.js'
import { unknownSkillsWarning } from '../src/config/skills.js'
import { ruleMatches } from '../src/core/queue.js'
import { asanaTask, githubPr } from './fakes/items.js'

const example = await readFile(new URL('fixtures/example.yml', import.meta.url), 'utf8')
const tmp = () => mkdtemp(join(tmpdir(), 'awaywork-customize-'))

describe('plan --rules', () => {
  const queue = parseConfig(example).queue ?? []
  const items = [
    githubPr(1, { checks: 'failing', review_requested: true }),
    githubPr(2, { mine: false, review_requested: true }),
    asanaTask(7, { tags: ['backend'] }),
    asanaTask(8, { section: 'Done' }),
  ]

  it('shows what each rule takes and what an earlier rule takes from it', () => {
    const matches = ruleMatches(items, queue)
    expect(matches.map((m) => m.taken.map((i) => i.key))).toEqual([
      ['acme/api#1'],
      [],
      ['acme/api#2'],
      ['T-7'],
    ])
    expect(matches[2]?.shadowed).toEqual([{ item: items[0], by: 0 }])
    expect(formatRules(queue, items)).toMatchInlineSnapshot(`
      [
        "#1  fix        type=pr mine=true checks=failing",
        "     1 taken: acme/api#1",
        "#2  implement  source=github type=issue label=awaywork repo=acme/api",
        "     0 taken",
        "#3  review     type=pr review_requested=true",
        "     1 taken: acme/api#2",
        "     1 taken by #1: acme/api#1",
        "#4  implement  source=asana section=Ready tags=backend provider=codex",
        "     1 taken: T-7",
        "1 unmatched: T-8",
      ]
    `)
  })

  it('lists the same as JSON, with why each unmatched item misses', () => {
    const json = JSON.parse(rulesJson(queue, items, false))
    expect(json.rules[2]).toMatchObject({
      rule: 3,
      skill: 'review',
      summary: 'type=pr review_requested=true',
      taken: [{ source: 'github', key: 'acme/api#2' }],
      takenBy: [{ rule: 1, items: [{ key: 'acme/api#1' }] }],
    })
    expect(json.unmatched).toEqual([
      expect.objectContaining({
        key: 'T-8',
        reason:
          'matched no rule; closest #3 review: type is task, wants pr; review_requested is unset, wants true',
      }),
    ])
    expect(json).toMatchObject({ defaultQueue: false, warnings: [] })
  })
})

describe('skills', () => {
  it('lists built-in and user skills with origin and delivery', async () => {
    const userDir = await tmp()
    await mkdir(join(userDir, 'review'))
    await writeFile(join(userDir, 'review', 'SKILL.md'), '---\ndescription: Mine.\n---\n')
    const linked = await tmp()
    await writeFile(join(linked, 'SKILL.md'), '---\ndescription: Linked.\n---\n')
    await symlink(linked, join(userDir, 'house-style'))
    const text = await listSkills(userDir)
    expect(text).toContain('fix (built-in, draft_pr)\n  Fix the problems reported on an item')
    expect(text).toContain('plan (built-in, report)')
    expect(text).toContain('review (user, shadows built-in, draft_pr)\n  Mine.')
    expect(text).toContain('house-style (user, draft_pr)\n  Linked.')
  })

  it('lists them as JSON, judge and sync not to be picked for one item', async () => {
    const userDir = await tmp()
    await mkdir(join(userDir, 'triage'), { recursive: true })
    await writeFile(join(userDir, 'triage', 'SKILL.md'), '---\ndescription: Mine.\n---\n')
    const { skills } = JSON.parse(await skillsJson(userDir))
    const of = (name: string) => skills.find((s: { name: string }) => s.name === name)
    expect(of('fix')).toEqual({
      name: 'fix',
      deliver: 'draft_pr',
      pickable: true,
    })
    expect(of('plan')).toMatchObject({ deliver: 'report', pickable: true })
    expect(of('triage')).toMatchObject({ pickable: true })
    expect(of('judge').pickable).toBe(false)
    expect(of('sync').pickable).toBe(false)
  })

  it('ejects a built-in once, and only a built-in', async () => {
    const userDir = await tmp()
    const to = await ejectSkill('fix', userDir)
    expect(await readFile(join(to, 'SKILL.md'), 'utf8')).toBe(
      await readFile(join(builtinSkillsDir, 'fix', 'SKILL.md'), 'utf8'),
    )
    await expect(ejectSkill('fix', userDir)).rejects.toThrow(/already exists/)
    await expect(ejectSkill('nope', userDir)).rejects.toThrow(/no built-in skill "nope"/)
  })
})

describe('unknown skills', () => {
  it('warns about a skill only the repo may have', async () => {
    const dir = await tmp()
    const path = join(dir, 'config.yml')
    const original = 'providers: [claude]\nrepos: { a/b: {} }\nsources: { github: {} }\n'
    await mkdir(join(dir, 'skills', 'mine'), { recursive: true })
    await writeFile(join(dir, 'skills', 'mine', 'SKILL.md'), '---\nname: mine\n---\n')
    await writeFile(path, `${original}queue: [{ skill: mine, skills: [ours] }]\n`)
    expect(await unknownSkillsWarning(await loadConfig(path), join(dir, 'skills'))).toBe(
      `queue[0]: unknown skill "ours" (not built in, not in ${join(dir, 'skills')}); fine only if every repo it runs in has it in .awaywork/skills, or as an extra in .claude/skills, .agents/skills or .cursor/skills; a run fails wherever it is missing`,
    )
  })
})
