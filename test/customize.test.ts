import { mkdir, mkdtemp, readFile, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { editUntilValid } from '../src/cli/config.js'
import { formatRules, rulesJson } from '../src/cli/format.js'
import { ejectSkill, listSkills } from '../src/cli/skills.js'
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

describe('config edit', () => {
  it('saves only a valid draft, asking to edit again after a mistake', async () => {
    const dir = await tmp()
    const path = join(dir, 'config.yml')
    const draft = join(dir, 'draft.yml')
    const original = 'providers: [claude]\nsources: { github: { repos: [a/b] } }\n'
    await writeFile(path, original)
    const edits = [original.replace('claude', 'gemini'), original.replace('[a/b]', '[a/b, c/d]')]
    const problems: string[][] = []
    const outcome = await editUntilValid({
      path,
      original,
      draft,
      edit: () => writeFile(draft, edits.shift() ?? ''),
      retry: async (e) => {
        problems.push(e.problems)
        expect(await readFile(path, 'utf8')).toBe(original)
        return true
      },
    })
    expect(outcome).toBe('saved')
    expect(problems).toEqual([['providers[0]: unknown provider "gemini"']])
    expect(await readFile(path, 'utf8')).toContain('[a/b, c/d]')
  })

  it('reports an untouched draft, and a discarded one leaves the config alone', async () => {
    const dir = await tmp()
    const path = join(dir, 'config.yml')
    const original = 'providers: [claude]\nsources: { github: { repos: [a/b] } }\n'
    await writeFile(path, original)
    const run = (edit: () => Promise<void>) =>
      editUntilValid({ path, original, draft: join(dir, 'd.yml'), edit, retry: async () => false })
    expect(await run(async () => {})).toBe('unchanged')
    expect(await run(() => writeFile(join(dir, 'd.yml'), 'providers: [gemini]'))).toBe('discarded')
    expect(await readFile(path, 'utf8')).toBe(original)
  })

  it('saves a skill only the repo may have, and warns about it', async () => {
    const dir = await tmp()
    const path = join(dir, 'config.yml')
    const original = 'providers: [claude]\nsources: { github: { repos: [a/b] } }\n'
    await mkdir(join(dir, 'skills', 'mine'), { recursive: true })
    await writeFile(join(dir, 'skills', 'mine', 'SKILL.md'), '---\nname: mine\n---\n')
    await writeFile(path, original)
    const draft = join(dir, 'd.yml')
    const edit = () => writeFile(draft, `${original}queue: [{ skill: mine, skills: [ours] }]\n`)
    expect(await editUntilValid({ path, original, draft, edit, retry: async () => false })).toBe(
      'saved',
    )
    expect(await unknownSkillsWarning(await loadConfig(path), join(dir, 'skills'))).toBe(
      `queue[0]: unknown skill "ours" (not built in, not in ${join(dir, 'skills')}); fine only if every repo it runs in has it in .awaywork/skills, or as an extra in .claude/skills or .agents/skills; a run fails wherever it is missing`,
    )
  })
})
