import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { editUntilValid } from '../src/cli/config.js'
import { type Cursor, formatQueue, moveOrder, press } from '../src/cli/queue.js'
import { ejectSkill, listSkills } from '../src/cli/skills.js'
import { queueYaml, withQueueOrder } from '../src/config/edit.js'
import { parseConfig } from '../src/config/load.js'
import { builtinSkillsDir } from '../src/config/paths.js'
import { defaultQueue, ruleMatches } from '../src/core/queue.js'
import type { Rule } from '../src/core/types.js'
import { asanaTask, githubPr } from './fakes/items.js'

const example = await readFile(new URL('fixtures/example.yml', import.meta.url), 'utf8')
const tmp = () => mkdtemp(join(tmpdir(), 'nightshift-customize-'))

describe('queue order in the config text', () => {
  it('moves rules with the comments above them and leaves the rest untouched', () => {
    const text = [
      'providers: [claude] # keep me',
      'queue:',
      '  # CI first',
      '  - skill: fix-ci',
      '    where: { checks: failing } # red',
      '',
      '  - skill: review',
      '    where:',
      '      review_requested: true',
      'sources: { github: { repos: [a/b] } }',
      '',
    ].join('\n')
    expect(withQueueOrder(text, [], [1, 0])).toBe(
      [
        'providers: [claude] # keep me',
        'queue:',
        '  - skill: review',
        '    where:',
        '      review_requested: true',
        '',
        '  # CI first',
        '  - skill: fix-ci',
        '    where: { checks: failing } # red',
        'sources: { github: { repos: [a/b] } }',
        '',
      ].join('\n'),
    )
  })

  it('reorders the plan example into a config that parses to the same rules', () => {
    const next = withQueueOrder(example, [], [3, 2, 1, 0])
    const before = parseConfig(example).queue ?? []
    expect(parseConfig(next).queue).toEqual([...before].reverse())
    expect(next.slice(0, next.indexOf('queue:'))).toBe(example.slice(0, example.indexOf('queue:')))
  })

  it('writes the default queue when the config has none', () => {
    const [fixCi, , addressReview, review] = defaultQueue as [Rule, Rule, Rule, Rule]
    const next = withQueueOrder('providers: [claude]', defaultQueue, [3, 0])
    expect(next).toBe(`providers: [claude]\n${queueYaml([review, fixCi])}`)
    expect(queueYaml([{ ...addressReview, provider: ['codex'], skills: [] }])).toContain(
      '    where: {type: pr, mine: true, unresolved_threads: {not: 0}}\n    provider: [codex]\n',
    )
  })

  it('refuses a flow-style queue', () => {
    expect(() => withQueueOrder('queue: [{ skill: a }, { skill: b }]', [], [1, 0])).toThrow(
      /block list/,
    )
  })
})

describe('queue screen', () => {
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
    expect(formatQueue(queue, items).flat()).toMatchInlineSnapshot(`
      [
        "#1  fix-ci     type=pr mine=true checks=failing",
        "     1 tonight: acme/api#1",
        "#2  implement  source=github type=issue label=night-shift repo=acme/api",
        "     0 tonight",
        "#3  review     type=pr review_requested=true",
        "     1 tonight: acme/api#2",
        "     1 taken by #1: acme/api#1",
        "#4  implement  source=asana section=Ready tags=backend provider=codex",
        "     1 tonight: T-7",
        "1 unmatched: T-8",
      ]
    `)
  })

  it('moves the cursor, or the rule once grabbed, and stays in bounds', () => {
    let state: Cursor = { order: [0, 1, 2], at: 0, grabbed: false }
    const keys = (...names: string[]) => {
      for (const name of names) state = press(state, name) as Cursor
    }
    keys('up', 'down')
    expect(state).toEqual({ order: [0, 1, 2], at: 1, grabbed: false })
    keys('space', 'down', 'down')
    expect(state).toEqual({ order: [0, 2, 1], at: 2, grabbed: true })
    keys('space', 'k', 'k')
    expect(state).toEqual({ order: [0, 2, 1], at: 0, grabbed: false })
    expect(press(state, 'return')).toBe('save')
    expect(press(state, 'q')).toBe('quit')
    expect(press(state, 'x')).toBe(state)
  })

  it('moves a rule by position, up or down, and refuses positions out of range', () => {
    expect(moveOrder(4, 3, 1)).toEqual([2, 0, 1, 3])
    expect(moveOrder(4, 1, 3)).toEqual([1, 2, 0, 3])
    expect(moveOrder(4, 2, 2)).toEqual([0, 1, 2, 3])
    expect(parseConfig(withQueueOrder(example, [], moveOrder(4, 3, 1) ?? [])).queue).toEqual(
      [2, 0, 1, 3].map((i) => queue[i]),
    )
    for (const bad of [0, 5, 1.5, Number.NaN]) {
      expect(moveOrder(4, bad, 1)).toBeUndefined()
      expect(moveOrder(4, 1, bad)).toBeUndefined()
    }
  })
})

describe('skills', () => {
  it('lists built-in and user skills with origin and delivery', async () => {
    const userDir = await tmp()
    await mkdir(join(userDir, 'review'))
    await writeFile(join(userDir, 'review', 'SKILL.md'), '---\ndescription: Mine.\n---\n')
    const text = await listSkills(userDir)
    expect(text).toContain('fix-ci (built-in, draft_pr)\n  Fix the failing checks')
    expect(text).toContain('plan (built-in, report)')
    expect(text).toContain('review (user, shadows built-in, draft_pr)\n  Mine.')
  })

  it('ejects a built-in once, and only a built-in', async () => {
    const userDir = await tmp()
    const to = await ejectSkill('fix-ci', userDir)
    expect(await readFile(join(to, 'SKILL.md'), 'utf8')).toBe(
      await readFile(join(builtinSkillsDir, 'fix-ci', 'SKILL.md'), 'utf8'),
    )
    await expect(ejectSkill('fix-ci', userDir)).rejects.toThrow(/already exists/)
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
    expect(await run(() => writeFile(join(dir, 'd.yml'), 'queue: [{ skill: nope }]'))).toBe(
      'discarded',
    )
    expect(await readFile(path, 'utf8')).toBe(original)
  })
})
