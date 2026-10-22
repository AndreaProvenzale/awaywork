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
  it('parses the full example', () => {
    const cfg = parseConfig(example)
    expect(cfg.providers.map((p) => p.id)).toEqual(['claude', 'codex'])
    expect(cfg.queue?.[3]).toMatchObject({
      provider: ['codex'],
      instructions: ['notes/backend.md'],
    })
  })

  it('parses `with` on a rule and a step, and rejects nested values and empty keys', () => {
    const cfg = parseConfig(
      `${minimal}\nqueue:\n  - skill: review\n    with: { depth: quick }\n    then:\n      - skill: fix\n        with: { tries: 2 }\n`,
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
      per_run: 0.15,
      session_max: 0.9,
      fallback: { units: 4, turns: 60 },
    })
    expect(codex?.budget.per_run).toBe(0.05)
    expect(parseConfig(minimal).budget).toEqual({
      reserve: 0.1,
      session_max: 0.9,
      fallback: { units: 4, turns: 60 },
    })
  })

  it('defaults fallback turns, inheriting top-level caps an override leaves out', () => {
    const fallbacks = (budget: string, override: string) =>
      parseConfig(
        `providers: [claude: { budget: { fallback: ${override} } }, codex]\nsources: { github: { repos: [acme/api] } }\nbudget: { fallback: ${budget} }\n`,
      ).providers.map((p) => p.budget.fallback)
    expect(fallbacks('{ units: 2 }', '{ units: 1 }')).toEqual([
      { units: 1, turns: 60 },
      { units: 2, turns: 60 },
    ])
    expect(fallbacks('{ units: 2, turns: 30 }', '{ units: 1 }')).toEqual([
      { units: 1, turns: 30 },
      { units: 2, turns: 30 },
    ])
    expect(fallbacks('{ units: 2, turns: 30 }', '{ units: 1, turns: 10 }')).toEqual([
      { units: 1, turns: 10 },
      { units: 2, turns: 30 },
    ])
    expect(fallbacks('{ units: 2, turns: 30 }', '{ turns: 10 }')).toEqual([
      { units: 2, turns: 10 },
      { units: 2, turns: 30 },
    ])
  })

  it('rejects a where key no source declares', () => {
    expect(problems(`${minimal}queue: [{ skill: fix, where: { colour: red } }]`)).toEqual([
      expect.stringMatching(
        /^queue\[0\]\.where\.colour: unknown key "colour"; use type, title, description, approved or .*github: repo, label/,
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
    const rule = (where: string) => `${minimal}queue: [{ skill: fix, where: ${where} }]`
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
    expect(
      problems(rule('{ title: { matches: "^\\\\[bug\\\\]" }, description: { matches: api } }')),
    ).toEqual([])
    expect(problems(rule('{ title: { matches: "[" } }'))).toEqual([
      expect.stringContaining('queue[0].where.title'),
    ])
    expect(problems(rule('{ unresolved_threads: { matches: x } }'))).toEqual([
      'queue[0].where.unresolved_threads: matches needs a text field',
    ])
    expect(problems(rule('{ any: [{ checks: failing }, { label: urgent }] }'))).toEqual([])
    expect(problems(rule('{ any: [{ checks: failing }, { nope: 1 }] }'))).toEqual([
      expect.stringContaining('queue[0].where.any[1].nope'),
    ])
    expect(problems(rule('{ any: [] }'))).toHaveLength(1)
    expect(problems(rule('{ any: [{ checks: failing }, {}] }'))).toEqual([
      'queue[0].where.any[1]: an empty entry matches everything',
    ])
    expect(problems(rule('{ any: [{ ours: true }, { label: urgent }] }'))).toEqual([
      'queue[0].where.any[0].ours: ours only lifts the awaywork PR wait at the top of where',
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

  it('needs an image for every repo under isolation: container', () => {
    const repos = 'repos: { acme/api: { setup: npm ci }, acme/web: { image: acme/web:dev } }'
    expect(problems(`${minimal}isolation: container\n${repos}`)).toEqual([
      'repos.acme/api.image: required with isolation: container: the image its units run in',
    ])
    expect(problems(`${minimal}isolation: user\n${repos}`)).toEqual([])
  })

  it('rejects unknown and unconfigured providers and sources', () => {
    expect(problems('providers: [gemini: {}]\nsources: { github: { repos: [a/b] } }')).toEqual([
      'providers[0]: gemini.command: not a built-in provider; a custom provider needs a `command`',
    ])
    expect(problems('providers: [gemini]\nsources: { github: { repos: [a/b] } }')).toEqual([
      'providers[0]: unknown provider "gemini"',
    ])
    expect(problems(`${minimal}queue: [{ skill: fix, provider: codex, source: asana }]`)).toEqual([
      'queue[0].source: source "asana" is not configured',
      'queue[0].provider: provider "codex" is not configured',
    ])
  })

  it('takes MCP servers named on rules and steps, with secrets only in headers or by name', () => {
    const servers = `mcp:
  sentry:
    url: https://mcp.sentry.dev/mcp
    headers: { Authorization: "Bearer \${SENTRY_TOKEN}", X-Org: acme }
    secrets: [SENTRY_TOKEN]
  db:
    command: npx
    args: [-y, db-mcp]
    env: { READ_ONLY: "1" }
    secrets: [DATABASE_URL]
    tools: [query]
`
    const cfg = parseConfig(
      `${minimal}${servers}queue:\n  - { skill: fix, mcp: [sentry], then: [{ skill: review, mcp: [db] }] }\n`,
    )
    expect(cfg.mcp.db).toMatchObject({
      command: 'npx',
      secrets: ['DATABASE_URL'],
      tools: ['query'],
    })
    expect(cfg.queue?.[0]?.mcp).toEqual(['sentry'])
    expect(cfg.queue?.[0]?.then?.[0]).toMatchObject({ mcp: ['db'] })
    expect(problems(`${minimal}queue: [{ skill: fix, mcp: [jira] }]`)).toEqual([
      'queue[0].mcp: MCP server "jira" is not configured',
    ])
    const server = (yaml: string) => problems(`${minimal}mcp: { s: ${yaml} }`)
    expect(server('{ command: x, url: "https://a.b" }')).toEqual([
      'mcp.s.command: expected command (stdio) or url (HTTP), not both',
    ])
    expect(server('{ secrets: [T] }')).toEqual([
      'mcp.s.command: expected command (stdio) or url (HTTP)',
    ])
    expect(server('{ url: "https://a.b", secrets: [T] }')).toEqual([
      'mcp.s.secrets: T: an HTTP server gets a secret only in a header, like Bearer ${T}',
    ])
    expect(server('{ command: x, args: ["${T}"], secrets: [T] }')).toEqual([
      expect.stringMatching(/^mcp.s.args: a secret can't go in command, args, env or url/),
    ])
    expect(server('{ command: x, env: { T: "${T}" }, secrets: [T] }')).toEqual([
      expect.stringMatching(/^mcp.s.env: /),
    ])
    expect(server('{ command: x, secrets: [GITHUB_TOKEN] }')).toEqual([
      expect.stringMatching(/^mcp.s.secrets\[0\]: GH_ and GITHUB_ names are reserved/),
    ])
    expect(server('{ url: "file:///x" }')).toHaveLength(1)
    expect(server('{ command: x, tools: ["a, b"] }')).toEqual([
      'mcp.s.tools[0]: expected a tool name like search_issues',
    ])
    expect(problems(`${minimal}mcp: { My_DB: { command: x } }`)).toEqual([
      'mcp.My_DB: expected a lowercase name like sentry',
    ])
    expect(server('{ url: "https://a.b", headers: { A: "${T}" } }')).toEqual([
      "mcp.s.headers: A: ${T} is not one of this server's secrets",
    ])
    expect(server('{ url: "https://a.b", headers: { X: "Bearer ${T}" }, secrets: [T] }')).toEqual([
      'mcp.s.headers: X: expected ${NAME}, or Bearer ${NAME} for Authorization',
    ])
  })

  it('expands a leading ~/ in the config path', () => {
    expect(configPath('~/away.yml')).toBe(join(homedir(), 'away.yml'))
    expect(configPath('/etc/~/away.yml')).toBe('/etc/~/away.yml')
    expect(configPath('~other/away.yml')).toBe('~other/away.yml')
    vi.stubEnv('AWAYWORK_CONFIG', '~/env.yml')
    expect(configPath()).toBe(join(homedir(), 'env.yml'))
    vi.unstubAllEnvs()
  })

  it('takes a list of models per provider on a rule', () => {
    const cfg = parseConfig(`${minimal}queue: [{ skill: fix, model: { claude: [sonnet, opus] } }]`)
    expect(cfg.queue?.[0]?.model).toEqual({ claude: ['sonnet', 'opus'] })
    expect(problems(`${minimal}queue: [{ skill: fix, model: { claude: [sonnet] } }]`)).not.toEqual(
      [],
    )
  })

  it('takes a model per provider and per rule', () => {
    const cfg = parseConfig(
      `${minimal.replace('[claude: {}]', '[claude: { model: opus }, codex]')}queue: [{ skill: fix, model: { codex: gpt-5-codex } }]`,
    )
    expect(cfg.providers.map((p) => [p.id, p.model])).toEqual([
      ['claude', 'opus'],
      ['codex', undefined],
    ])
    expect(cfg.queue?.[0]?.model).toEqual({ codex: 'gpt-5-codex' })
    expect(problems(`${minimal}queue: [{ skill: fix, model: { codex: gpt-5-codex } }]`)).toEqual([
      'queue[0].model.codex: provider "codex" is not configured',
    ])
  })

  it('takes then as one step or a list, each a skill name or a map', () => {
    const cfg = parseConfig(`${minimal.replace('[claude: {}]', '[claude, codex]')}queue:
  - { skill: implement, then: review }
  - { skill: plan, then: [implement, { skill: review, provider: codex }] }
  - { skill: fix }
`)
    expect(
      cfg.queue?.map((r) => r.then?.map((s) => [(s as Step).skill, (s as Step).provider])),
    ).toEqual([
      [['review', undefined]],
      [
        ['implement', undefined],
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
    for (const key of ['deliver: push', 'branch: "fix/{key}"'])
      expect(
        problems(`${minimal}queue: [{ skill: plan, then: { skill: review, ${key} } }]`),
      ).toEqual([`queue[0].then: Unrecognized key: "${key.split(':')[0]}"`])
  })

  it('takes a loop in then, with its steps once across loops, a verdict word and a bounded max', () => {
    const cfg = parseConfig(`${minimal.replace('[claude: {}]', '[claude, codex]')}queue:
  - skill: implement
    then:
      - loop: [{ skill: review, provider: codex }, fix]
        until: { verdict: [approve, comments] }
        max: 3
  - { skill: plan, then: { loop: implement, until: { verdict: { not: changes } }, max: 1 } }
`)
    expect(cfg.queue?.map((r) => r.then)).toEqual([
      [
        {
          loop: [{ skill: 'review', provider: ['codex'] }, { skill: 'fix' }],
          until: { verdict: ['approve', 'comments'] },
          max: 3,
        },
      ],
      [
        {
          loop: [{ skill: 'implement' }],
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
    // Loops can follow loops, and a step gated by when can come right before one.
    expect(
      problems(`${minimal}queue:
  - skill: implement
    when: { headroom: 20% }
    then:
      - { skill: review, when: { verdict: approve } }
      - { loop: [fix], until: { verdict: approve }, max: 2 }
      - { loop: [plan], until: { verdict: approve }, max: 2 }
`),
    ).toEqual([])
  })

  it('takes a quota when on a rule, not on a step', () => {
    const cfg = parseConfig(`${minimal}queue:
  - skill: implement
    when: { runs_until_reset: 1, headroom: 20% }
`)
    expect(cfg.queue?.[0]).toMatchObject({ when: { runs_until_reset: 1, headroom: 0.2 } })
    expect(
      problems(
        `${minimal}queue: [{ skill: implement, then: { skill: review, when: { headroom: 50% } } }]`,
      ),
    ).toEqual([
      "queue[0].then.when: headroom: a quota check goes on the rule's when, which gates the whole chain",
    ])
    expect(
      problems(
        `${minimal}queue: [{ skill: implement, then: { skill: review, when: { headroom: 50%, nope: 1 } } }]`,
      ),
    ).toEqual([
      "queue[0].then.when: headroom: a quota check goes on the rule's when, which gates the whole chain",
    ])
  })

  it('takes a command in until, and when on then and loop steps but not on a rule', () => {
    const cfg = parseConfig(`${minimal}queue:
  - skill: implement
    then:
      - loop: [{ skill: fix, when: { verdict: changes, command: "! pnpm test" } }, implement]
        until: { verdict: approve, command: pnpm test }
        max: 2
      - { skill: review, when: { changed: "src/auth/**" } }
`)
    const [loop, step] = cfg.queue?.[0]?.then ?? []
    expect(step).toMatchObject({ skill: 'review', when: { changed: ['src/auth/**'] } })
    expect(loop).toMatchObject({
      loop: [
        { skill: 'fix', when: { verdict: 'changes', command: '! pnpm test' } },
        { skill: 'implement' },
      ],
      until: { verdict: 'approve', command: 'pnpm test' },
    })
    expect(problems(`${minimal}queue: [{ skill: implement, when: { verdict: approve } }]`)).toEqual(
      ['queue[0].when: Unrecognized key: "verdict"'],
    )
    expect(problems(`${minimal}queue: [{ skill: implement, when: {} }]`)).toEqual([
      'queue[0].when: expected runs_until_reset or headroom',
    ])
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
  })

  it('takes stack on a step or a loop of a draft_pr chain only, never inside a loop', () => {
    const chain = (rule: string) => problems(`${minimal}queue: [{ skill: implement, ${rule} }]`)
    expect(
      chain(
        'then: [review, { skill: fix, stack: true }, { loop: [plan], until: { verdict: approve }, max: 1, stack: true }]',
      ),
    ).toEqual([])
    expect(chain('deliver: push, then: [{ skill: fix, stack: true }]')).toEqual([
      'queue[0].then[0].stack: stack needs deliver: draft_pr, not push: a stacked slice opens a draft PR',
    ])
    expect(chain('deliver: report, then: { skill: plan, stack: true }')).toEqual([
      'queue[0].then[0].stack: stack needs deliver: draft_pr, not report: a stacked slice opens a draft PR',
    ])
    expect(
      chain(
        'then: { loop: [review, { skill: fix, stack: true }], until: { verdict: approve }, max: 2 }',
      ),
    ).toEqual([
      'queue[0].then[0].loop[1].stack: a loop sits inside one slice: set stack on the loop',
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
    expect(problems(rule('{ repo: { matches: "^acme/" }, column: { matches: ready } }'))).toEqual(
      [],
    )
    expect(problems(rule('{ created: { matches: "2024" } }'))).toEqual([
      'queue[0].where.created: matches needs a text field',
    ])
    expect(problems(rule('{ colour: red }'))).toEqual([
      expect.stringMatching(/unknown key "colour"; .*tracker: repo, created, updated, column/),
    ])
    expect(problems(cfg.replace('fields: [column]', 'fields: [column, any]'))).toEqual([
      'sources.tracker.fields[1]: `any` is reserved in where',
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
      minimal.replace('[claude: {}]', '[claude, codex: { budget: { per_run: 5% } }]'),
    )
    expect(cfg.providers.map((p) => [p.id, p.budget.per_run])).toEqual([
      ['claude', undefined],
      ['codex', 0.05],
    ])
  })

  it('takes a list of windows with optional weekdays, defaults to one, and rejects an empty one', () => {
    const cfg = parseConfig(
      `${minimal}windows: [{ start: "01:00", end: "07:00" }, { days: [sat, sun], start: "10:00", end: "18:00" }]`,
    )
    expect(cfg.windows).toEqual([
      { start: '01:00', end: '07:00' },
      { days: ['sat', 'sun'], start: '10:00', end: '18:00' },
    ])
    expect(parseConfig(minimal).windows).toEqual([{ start: '01:00', end: '07:00' }])
    expect(problems(`${minimal}windows: [{ start: "01:00", end: "01:00" }]`)).toEqual([
      'windows[0]: start and end must differ',
    ])
    expect(problems(`${minimal}windows: []`)).toHaveLength(1)
  })

  it('takes limits for every provider, not per provider', () => {
    const cfg = parseConfig(`${minimal}limits: { units: 6, units_per_repo: 2, unit_minutes: 90 }`)
    expect(cfg.limits).toEqual({ units: 6, units_per_repo: 2, unit_minutes: 90 })
    expect(parseConfig(minimal).limits).toEqual({})
    expect(problems(`${minimal}limits: { unit_minutes: 0 }`)).toEqual([
      expect.stringMatching(/^limits\.unit_minutes: /),
    ])
    expect(
      problems(minimal.replace('[claude: {}]', '[claude: { budget: { unit_minutes: 30 } }]')),
    ).toEqual([expect.stringContaining('Unrecognized key: "unit_minutes"')])
  })

  it('reports YAML syntax errors', () => {
    expect(problems('providers: [claude: {}')[0]).toMatch(/flow sequence/i)
  })
})

describe('skills', () => {
  it('accepts built-in and user skills and names unknown ones', async () => {
    const userDir = await mkdtemp(join(tmpdir(), 'awaywork-skills-'))
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
