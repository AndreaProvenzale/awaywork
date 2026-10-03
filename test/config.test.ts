import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { ConfigError, configPath, parseConfig } from '../src/config/load.js'
import { unknownSkills } from '../src/config/skills.js'
import type { Step } from '../src/core/types.js'

const example = await readFile(new URL('fixtures/example.yml', import.meta.url), 'utf8')

const minimal = `
providers: [claude: {}]
sources: { github: { repos: [acme/api] } }
`

function problems(text: string): string[] {
  try {
    parseConfig(text)
    return []
  } catch (e) {
    if (e instanceof ConfigError) return e.problems
    throw e
  }
}

describe('config', () => {
  it('parses the example from plan.md', () => {
    const cfg = parseConfig(example)
    expect(cfg.providers.map((p) => p.id)).toEqual(['claude', 'codex'])
    expect(cfg.queue?.[3]).toMatchObject({
      provider: ['codex'],
      instructions: ['notes/backend.md'],
    })
  })

  it('parses `with` on a rule and a step, and rejects nested values and empty keys', () => {
    const cfg = parseConfig(
      `${minimal}\nqueue:\n  - skill: review\n    with: { depth: quick }\n    then:\n      - skill: fix-ci\n        with: { tries: 2 }\n`,
    )
    expect(cfg.queue?.[0]?.with).toEqual({ depth: 'quick' })
    expect(cfg.queue?.[0]?.then?.[0]).toMatchObject({ with: { tries: 2 } })
    expect(() =>
      parseConfig(`${minimal}\nqueue:\n  - skill: review\n    with: { a: [1] }\n`),
    ).toThrow()
    expect(() =>
      parseConfig(`${minimal}\nqueue:\n  - skill: review\n    with: { "": x }\n`),
    ).toThrow()
  })

  it('applies budget defaults and per-provider overrides', () => {
    const [claude, codex] = parseConfig(example).providers
    expect(claude?.budget).toEqual({
      reserve: 0.1,
      per_night: 0.15,
      session_max: 0.9,
      fallback: { units: 4, turns: 60 },
    })
    expect(codex?.budget.per_night).toBe(0.05)
    expect(parseConfig(minimal).budget).toEqual({
      reserve: 0.1,
      session_max: 0.9,
      fallback: { units: 4, turns: 60 },
    })
  })

  it('rejects a where key no source declares', () => {
    expect(problems(`${minimal}queue: [{ skill: fix-ci, where: { colour: red } }]`)).toEqual([
      expect.stringMatching(
        /^queue\[0\]\.where\.colour: unknown key "colour"; .*github: repo, label/,
      ),
    ])
  })

  it('checks where keys against the rule source only', () => {
    const cfg = `${minimal}  asana: { workspace: "1" }\n`.replace(
      'sources: { github: { repos: [acme/api] } }',
      'sources:\n  github: { repos: [acme/api] }',
    )
    expect(
      problems(`${cfg}queue: [{ skill: implement, source: github, where: { section: Ready } }]`),
    ).toEqual([expect.stringContaining('unknown key "section"')])
    expect(
      problems(`${cfg}queue: [{ skill: implement, where: { section: Ready, mine: true } }]`),
    ).toEqual([])
  })

  it('validates where values, lists and negation', () => {
    const rule = (where: string) => `${minimal}queue: [{ skill: fix-ci, where: ${where} }]`
    expect(problems(rule('{ checks: [failing, pending], mine: { not: false } }'))).toEqual([])
    expect(problems(rule('{ checks: red }'))).toEqual([
      'queue[0].where.checks: invalid value "red"',
    ])
    expect(problems(rule('{ type: { not: epic } }'))).toEqual([
      'queue[0].where.type: invalid value "epic"',
    ])
    expect(problems(rule('{ unresolved_threads: { gte: 2, lt: 5 } }'))).toEqual([])
    expect(problems(rule('{ checks: { gte: 2 } }'))).toEqual([
      'queue[0].where.checks: invalid value 2',
    ])
    expect(problems(rule('{ unresolved_threads: {} }'))).toEqual([
      expect.stringContaining('queue[0].where.unresolved_threads'),
    ])
    expect(problems(rule('{ updated: { older_than: 3d, newer_than: 2w } }'))).toEqual([])
    expect(problems(rule('{ created: { older_than: 3 days } }'))).toEqual([
      expect.stringContaining('queue[0].where.created'),
    ])
    expect(problems(rule('{ checks: { newer_than: 1h } }'))).toEqual([
      'queue[0].where.checks: older_than and newer_than need a date field',
    ])
  })

  it('takes a rule order', () => {
    const rule = (order: string) => `${minimal}queue: [{ skill: implement, order: ${order} }]`
    expect(parseConfig(rule('oldest')).queue?.[0]?.order).toBe('oldest')
    expect(problems(rule('random'))).toEqual([expect.stringContaining('queue[0].order')])
  })

  it('rejects unknown and unconfigured providers and sources', () => {
    expect(problems('providers: [gemini: {}]\nsources: { github: { repos: [a/b] } }')).toEqual([
      expect.stringContaining('providers[0]: Unrecognized key: "gemini"'),
    ])
    expect(problems('providers: [gemini]\nsources: { github: { repos: [a/b] } }')).toEqual([
      'providers[0]: unknown provider "gemini"',
    ])
    expect(
      problems(`${minimal}queue: [{ skill: fix-ci, provider: codex, source: asana }]`),
    ).toEqual([
      'queue[0].source: source "asana" is not configured',
      'queue[0].provider: provider "codex" is not configured',
    ])
  })

  it('expands a leading ~/ in the config path', () => {
    expect(configPath('~/night.yml')).toBe(join(homedir(), 'night.yml'))
    expect(configPath('/etc/~/night.yml')).toBe('/etc/~/night.yml')
    expect(configPath('~other/night.yml')).toBe('~other/night.yml')
    vi.stubEnv('NIGHT_SHIFT_CONFIG', '~/env.yml')
    expect(configPath()).toBe(join(homedir(), 'env.yml'))
    vi.unstubAllEnvs()
  })

  it('takes a model per provider and per rule', () => {
    const cfg = parseConfig(
      `${minimal.replace('[claude: {}]', '[claude: { model: opus }, codex]')}queue: [{ skill: fix-ci, model: { codex: gpt-5-codex } }]`,
    )
    expect(cfg.providers.map((p) => [p.id, p.model])).toEqual([
      ['claude', 'opus'],
      ['codex', undefined],
    ])
    expect(cfg.queue?.[0]?.model).toEqual({ codex: 'gpt-5-codex' })
    expect(problems(`${minimal}queue: [{ skill: fix-ci, model: { codex: gpt-5-codex } }]`)).toEqual(
      ['queue[0].model.codex: provider "codex" is not configured'],
    )
  })

  it('takes then as one step or a list, each a skill name or a map', () => {
    const cfg = parseConfig(`${minimal.replace('[claude: {}]', '[claude, codex]')}queue:
  - { skill: implement, then: review }
  - { skill: plan, then: [implement, { skill: review, provider: codex }] }
  - { skill: fix-ci }
`)
    expect(
      cfg.queue?.map((r) => r.then?.map((s) => [(s as Step).skill, (s as Step).provider])),
    ).toEqual([
      [['review', []]],
      [
        ['implement', []],
        ['review', ['codex']],
      ],
      [],
    ])
    expect(
      problems(
        `${minimal}queue: [{ skill: plan, then: [implement, { skill: plan, provider: codex }] }]`,
      ),
    ).toEqual([
      'queue[0].then[1].skill: "plan" already runs earlier in this chain',
      'queue[0].then[1].provider: provider "codex" is not configured',
    ])
    expect(
      problems(`${minimal}queue: [{ skill: plan, then: { skill: review, where: {} } }]`),
    ).toEqual(['queue[0].then: Unrecognized key: "where"'])
    expect(
      problems(`${minimal}queue: [{ skill: plan, then: { skill: review, units: 1 } }]`),
    ).toEqual(['queue[0].then: Unrecognized key: "units"'])
  })

  it('takes a loop in then, with its steps once across loops, a verdict word and a bounded max', () => {
    const cfg = parseConfig(`${minimal.replace('[claude: {}]', '[claude, codex]')}queue:
  - skill: implement
    then:
      - loop: [{ skill: review, provider: codex }, address-review]
        until: { verdict: [approve, comments] }
        max: 3
  - { skill: plan, then: { loop: implement, until: { verdict: { not: changes } }, max: 1 } }
`)
    expect(cfg.queue?.map((r) => r.then)).toEqual([
      [
        {
          loop: [
            { skill: 'review', provider: ['codex'], skills: [], instructions: [] },
            { skill: 'address-review', provider: [], skills: [], instructions: [] },
          ],
          until: { verdict: ['approve', 'comments'] },
          max: 3,
        },
      ],
      [
        {
          loop: [{ skill: 'implement', provider: [], skills: [], instructions: [] }],
          until: { verdict: { not: 'changes' } },
          max: 1,
        },
      ],
    ])
    const loop = (body: string) =>
      problems(`${minimal}queue: [{ skill: implement, then: { loop: ${body} } }]`)
    expect(loop('[review, implement], until: { verdict: approve }, max: 2')).toEqual([])
    expect(loop('[review, review], until: { verdict: approve }, max: 2')).toEqual([
      'queue[0].then[0].loop[1].skill: "review" already runs in a loop of this chain',
    ])
    expect(loop('[review], until: { verdict: Approve }, max: 6')).toEqual([
      'queue[0].then.until.verdict: expected one lowercase word like approve',
      'queue[0].then.max: Too big: expected number to be <=5',
    ])
    expect(loop('[review], until: {}, max: 1')).toEqual([
      'queue[0].then.until: expected verdict or command',
    ])
    expect(
      loop('[review, { skill: fix-ci, deliver: push }], until: { verdict: approve }, max: 2'),
    ).toEqual([
      'queue[0].then[0].loop[1].deliver: a loop publishes through the unit before it: set deliver push there',
    ])
    const loops = (between: string) =>
      problems(`${minimal}queue:
  - skill: implement
    then:
      - { loop: [review, address-review], until: { verdict: approve }, max: 2 }${between}
      - { loop: [qa-feedback, fix-ci], until: { verdict: approve }, max: 2 }
`)
    expect(loops('')).toEqual([
      "queue[0].then[1].loop: a loop can't follow another loop directly; put a step between them",
    ])
    expect(loops('\n      - plan')).toEqual([])
    expect(
      problems(`${minimal}queue:
  - skill: implement
    then:
      - { skill: review, when: { verdict: approve } }
      - { loop: [address-review], until: { verdict: approve }, max: 2 }
`),
    ).toEqual([
      "queue[0].then[0].when: a loop works in the clone of the step before it, which can't be skipped by when; gate the loop's steps, put a step between, or set deliver: report on it",
    ])
    expect(
      problems(`${minimal}queue:
  - skill: implement
    then:
      - { skill: review, deliver: report, when: { verdict: approve } }
      - { loop: [address-review], until: { verdict: approve }, max: 2 }
`),
    ).toEqual([])
  })

  it('takes a command in until, and when on then and loop steps but not on a rule', () => {
    const cfg = parseConfig(`${minimal}queue:
  - skill: implement
    then:
      - loop: [{ skill: address-review, when: { verdict: changes, command: "! pnpm test" } }, qa-feedback]
        until: { verdict: approve, command: pnpm test }
        max: 2
      - { skill: review, when: { changed: "src/auth/**" } }
`)
    const [loop, step] = cfg.queue?.[0]?.then ?? []
    expect(step).toMatchObject({ skill: 'review', when: { changed: ['src/auth/**'] } })
    expect(loop).toMatchObject({
      loop: [
        { skill: 'address-review', when: { verdict: 'changes', command: '! pnpm test' } },
        { skill: 'qa-feedback' },
      ],
      until: { verdict: 'approve', command: 'pnpm test' },
    })
    expect(problems(`${minimal}queue: [{ skill: implement, when: { verdict: approve } }]`)).toEqual(
      ['queue[0]: Unrecognized key: "when"'],
    )
    expect(
      problems(`${minimal}queue: [{ skill: implement, then: { skill: review, when: {} } }]`),
    ).toEqual(['queue[0].then.when: expected verdict, command or changed'])
    expect(
      problems(
        `${minimal}queue: [{ skill: implement, then: { loop: review, until: { changed: src }, max: 1 } }]`,
      ),
    ).toEqual([
      'queue[0].then.until: Unrecognized key: "changed"',
      'queue[0].then.until: expected verdict or command',
    ])
    expect(
      problems(`${minimal}queue:
  - skill: implement
    network: false
    then:
      - { loop: [fix-ci], until: { command: pnpm test }, max: 1 }
      - { skill: review, when: { command: pnpm test } }
`),
    ).toEqual([
      "queue[0].then[0].until.command: a command can't run with network: false: night-shift has no sandbox for it",
      "queue[0].then[1].when.command: a command can't run with network: false: night-shift has no sandbox for it",
    ])
  })

  it('takes a custom source with a command and matches rules on its declared fields', () => {
    const cfg = minimal.replace(
      'sources: { github: { repos: [acme/api] } }',
      'sources: { tracker: { command: ./tracker, fields: [column] } }',
    )
    const rule = (where: string) =>
      `${cfg}queue: [{ skill: plan, source: tracker, where: ${where} }]`
    expect(parseConfig(cfg).sources.tracker).toEqual({
      command: './tracker',
      fields: ['column'],
      secrets: [],
    })
    expect(problems(rule('{ column: Ready, repo: acme/api }'))).toEqual([])
    expect(problems(rule('{ colour: red }'))).toEqual([
      expect.stringMatching(/unknown key "colour"; .*tracker: repo, created, updated, column/),
    ])
  })

  it('takes a link template on tracker and custom sources, with known placeholders', () => {
    const sources = (yaml: string) => minimal.replace('{ github: { repos: [acme/api] } }', yaml)
    const linear = parseConfig(sources('{ linear: { link: "Refs {key}" } }'))
    expect(linear.sources.linear).toMatchObject({ link: 'Refs {key}' })
    expect(
      problems(
        sources('{ jira: { site: acme.atlassian.net, email: me@acme.com, link: "See {ticket}" } }'),
      ),
    ).toEqual(['sources.jira.link: unknown placeholder {ticket}'])
    expect(problems(sources('{ tracker: { command: ./tracker, link: Refs } }'))).toEqual([
      'sources.tracker.link: must contain {key}, {id} or {url}',
    ])
    expect(problems(sources('{ github: { repos: [acme/api], link: "{url}" } }'))).toEqual([
      expect.stringContaining('Unrecognized key: "link"'),
    ])
  })

  it('rejects an unknown source that has no command', () => {
    expect(problems(minimal.replace('github:', 'githb:'))).toEqual([
      'sources.githb.command: not a built-in source; a custom source needs a `command`',
      expect.stringContaining('sources.githb: Unrecognized key: "repos"'),
    ])
  })

  it('takes bare provider names next to overrides', () => {
    const cfg = parseConfig(
      minimal.replace('[claude: {}]', '[claude, codex: { budget: { per_night: 5% } }]'),
    )
    expect(cfg.providers.map((p) => [p.id, p.budget.per_night])).toEqual([
      ['claude', undefined],
      ['codex', 0.05],
    ])
  })

  it('takes unit_minutes globally and per provider', () => {
    const cfg = parseConfig(
      `${minimal.replace('[claude: {}]', '[claude, codex: { budget: { unit_minutes: 30 } }]')}budget: { unit_minutes: 90 }`,
    )
    expect(cfg.providers.map((p) => [p.id, p.budget.unit_minutes])).toEqual([
      ['claude', 90],
      ['codex', 30],
    ])
    expect(problems(`${minimal}budget: { unit_minutes: 0 }`)).toEqual([
      expect.stringMatching(/^budget\.unit_minutes: /),
    ])
  })

  it('rejects a night window that starts when it ends', () => {
    expect(problems(`${minimal}night: { start: '01:00', end: '01:00' }`)).toEqual([
      'night: start and end must differ',
    ])
  })

  it('reports YAML syntax errors', () => {
    expect(problems('providers: [claude: {}')[0]).toMatch(/flow sequence/i)
  })
})

describe('skills', () => {
  it('accepts built-in and user skills and names unknown ones', async () => {
    const userDir = await mkdtemp(join(tmpdir(), 'nightshift-skills-'))
    const cfg = parseConfig(example)
    expect(await unknownSkills(cfg, userDir)).toEqual([
      `queue[3]: unknown skill "our-api-conventions" (not built in, not in ${userDir})`,
    ])
    await mkdir(join(userDir, 'our-api-conventions'))
    await writeFile(
      join(userDir, 'our-api-conventions', 'SKILL.md'),
      '---\nname: our-api-conventions\n---\n',
    )
    expect(await unknownSkills(cfg, userDir)).toEqual([])
    const top = parseConfig(`${minimal}skills: [house-style]`)
    expect(await unknownSkills(top, userDir)).toEqual([
      `skills: unknown skill "house-style" (not built in, not in ${userDir})`,
    ])
  })

  it('checks the skills of every step in a chain', async () => {
    const cfg = parseConfig(
      `${minimal}queue: [{ skill: implement, then: [review, { skill: our-review, skills: [house-style] }] }]`,
    )
    expect(await unknownSkills(cfg, '/none')).toEqual([
      'queue[0].then[1]: unknown skill "our-review" (not built in, not in /none)',
      'queue[0].then[1]: unknown skill "house-style" (not built in, not in /none)',
    ])
    const loop = parseConfig(
      `${minimal}queue: [{ skill: implement, then: { loop: [review, our-fix], until: { verdict: approve }, max: 2 } }]`,
    )
    expect(await unknownSkills(loop, '/none')).toEqual([
      'queue[0].then[0].loop[1]: unknown skill "our-fix" (not built in, not in /none)',
    ])
  })
})
