import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { Command } from 'commander'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { configCommand } from '../src/cli/config.js'
import { ConfigError, configPath, loadConfig, parseConfig } from '../src/config/load.js'
import { unknownSkills } from '../src/config/skills.js'
import type { Step } from '../src/core/types.js'

const example = await readFile(new URL('fixtures/example.yml', import.meta.url), 'utf8')

const minimal = `
providers: [claude: {}]
repos: { acme/api: {} }
sources: { github: {} }
`
const unlisted = minimal.replace('repos: { acme/api: {} }\n', '')

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

  it('applies budget defaults, and refuses a provider budget, which was removed', () => {
    expect(parseConfig(example).budget).toEqual({
      reserve: 0.1,
      per_run: 0.15,
      session_max: 0.9,
      present_session_max: 0.4,
      fallback: { units: 4, turns: 60 },
    })
    expect(
      problems(minimal.replace('[claude: {}]', '[claude, codex: { budget: { per_run: 5% } }]')),
    ).toEqual([
      'providers[1].codex: budget was removed: the top-level budget applies to every provider; a different budget takes a second config',
    ])
    expect(parseConfig(minimal).budget).toEqual({
      reserve: 0.1,
      session_max: 0.9,
      present_session_max: 0.4,
      fallback: { units: 4, turns: 60 },
    })
  })

  it('defaults fallback turns', () => {
    const fallback = (budget: string) =>
      parseConfig(`${minimal}budget: { fallback: ${budget} }\n`).budget.fallback
    expect(fallback('{ units: 2 }')).toEqual({ units: 2, turns: 60 })
    expect(fallback('{ units: 2, turns: 30 }')).toEqual({ units: 2, turns: 30 })
  })

  it('takes state and closed on every source, and points a Linear state at status', () => {
    const where = '{ state: [merged, closed], closed: { newer_than: 14d } }'
    expect(problems(`${minimal}queue: [{ skill: review, where: ${where} }]`)).toEqual([])
    const linear =
      'providers: [claude]\nsources: { linear: {} }\nqueue: [{ skill: fix, where: { state: QA } }]'
    expect(problems(linear)).toEqual([
      `queue[0].where.state: invalid value "QA": state is open, merged or closed; Linear's workflow state is status`,
    ])
    expect(problems(`${minimal}queue: [{ skill: fix, where: { state: QA } }]`)).toEqual([
      'queue[0].where.state: invalid value "QA": state is open, merged or closed',
    ])
  })

  it('wants newer_than wherever closed has older_than, to bound how far back to read', () => {
    const rule = (where: string) =>
      problems(`${minimal}queue: [{ skill: review, where: ${where} }]`)
    expect(rule('{ state: merged, closed: { older_than: 30d } }')).toEqual([
      'queue[0].where.closed: closed needs newer_than to bound how far back to read; without it, awaywork reads 7d back',
    ])
    expect(rule('{ state: merged, closed: { older_than: 3d, newer_than: 30d } }')).toEqual([])
    expect(
      rule('{ closed: { newer_than: 30d }, any: [{ state: merged, closed: { older_than: 3d } }] }'),
    ).toEqual([])
  })

  it('rejects closed where no state can be merged or closed', () => {
    const rule = (where: string) =>
      problems(`${minimal}queue: [{ skill: review, where: ${where} }]`)
    const message = 'closed only matches merged or closed items; add state: [merged, closed]'
    expect(rule('{ closed: { older_than: 3d, newer_than: 30d } }')).toEqual([
      `queue[0].where.closed: ${message}`,
    ])
    expect(rule('{ state: open, closed: { newer_than: 3d } }')).toEqual([
      `queue[0].where.closed: ${message}`,
    ])
    expect(rule('{ any: [{ label: x, closed: { newer_than: 3d } }] }')).toEqual([
      `queue[0].where.any[0].closed: ${message}`,
    ])
    expect(rule('{ state: [merged, closed], closed: { newer_than: 3d } }')).toEqual([])
  })

  it('rejects a where key no source declares', () => {
    expect(problems(`${minimal}queue: [{ skill: fix, where: { colour: red } }]`)).toEqual([
      expect.stringMatching(
        /^queue\[0\]\.where\.colour: unknown key "colour"; use type, title, description, approved, state, closed, planned or .*github: repo, label/,
      ),
    ])
  })

  it('checks where keys against the rule source only', () => {
    const cfg = `${minimal}  asana: { workspace: "1" }\n`.replace(
      'repos: { acme/api: {} }\nsources: { github: {} }',
      'repos: { acme/api: {} }\nsources:\n  github: {}',
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
    expect(problems(`${unlisted}isolation: container\n${repos}`)).toEqual([
      'repos.acme/api.image: required with isolation: container: the image its units run in',
    ])
    expect(problems(`${unlisted}isolation: user\n${repos}`)).toEqual([])
  })

  it('rejects unknown and unconfigured providers and sources', () => {
    expect(
      problems('providers: [gemini: {}]\nrepos: { a/b: {} }\nsources: { github: {} }'),
    ).toEqual([
      'providers[0]: gemini.command: not a built-in provider; a custom provider needs a `command`',
    ])
    expect(problems('providers: [gemini]\nrepos: { a/b: {} }\nsources: { github: {} }')).toEqual([
      'providers[0]: unknown provider "gemini"',
    ])
    const named =
      'providers: [cursor: { command: agent -p }]\nrepos: { a/b: {} }\nsources: { github: {} }'
    expect(problems(named)).toEqual([
      'providers[0].cursor: built in, so it takes no command; give your own provider another name',
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
      expect.stringMatching(/^mcp.s.secrets\[0\]: GH_, GITHUB_ and TWG_ names are reserved/),
    ])
    expect(server('{ command: x, secrets: [TWG_BBC_TOKEN] }')).toHaveLength(1)
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

  it('takes sync only as a rule of its own that says deliver: push', () => {
    const where = 'where: { type: pr, mine: true, behind: { gt: 0 }, conflicts: false }'
    expect(
      parseConfig(`${minimal}queue: [{ skill: sync, ${where}, deliver: push }]`).queue,
    ).toEqual([expect.objectContaining({ skill: 'sync', deliver: 'push' })])
    expect(problems(`${minimal}queue: [{ skill: sync, ${where} }]`)).toEqual([
      "queue[0].deliver: sync merges your PR's base and pushes the merge onto your PR: it needs deliver: push",
    ])
    expect(
      problems(
        `${minimal}queue: [{ skill: sync, deliver: push, then: fix, quota: { headroom: "20%" } }]`,
      ),
    ).toEqual([
      "queue[0].then: sync is awaywork's own merge, not a model's step: it takes no then",
      "queue[0].quota: sync is awaywork's own merge, which only spends quota on a conflict: drop quota",
    ])
    expect(problems(`${minimal}queue: [{ skill: fix, deliver: push, then: sync }]`)).toEqual([
      "queue[0].then[0].skill: sync is awaywork's own merge, a rule of its own: not a then step",
    ])
    expect(
      problems(
        `${minimal}queue: [{ skill: fix, then: { loop: [review, sync], until: { verdict: approve }, max: 2 } }]`,
      ),
    ).toEqual([
      "queue[0].then[0].loop[1].skill: sync is awaywork's own merge, a rule of its own: not a then step",
    ])
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
    quota: { headroom: 20% }
    then:
      - { skill: review, when: { verdict: approve } }
      - { loop: [fix], until: { verdict: approve }, max: 2 }
      - { loop: [plan], until: { verdict: approve }, max: 2 }
`),
    ).toEqual([])
  })

  it('takes quota on a rule with either key or both, not on a step', () => {
    const quota = (keys: string) =>
      parseConfig(`${minimal}queue: [{ skill: implement, quota: ${keys} }]`).queue?.[0]?.quota
    expect(quota('{ runs_until_reset: 1 }')).toEqual({ runs_until_reset: 1 })
    expect(quota('{ headroom: 20% }')).toEqual({ headroom: 0.2 })
    expect(quota('{ runs_until_reset: 1, headroom: 20% }')).toEqual({
      runs_until_reset: 1,
      headroom: 0.2,
    })
    expect(
      problems(
        `${minimal}queue: [{ skill: implement, then: { skill: review, when: { headroom: 50% } } }]`,
      ),
    ).toEqual([
      "queue[0].then.when: headroom: a quota check goes on the rule's quota, which gates the whole chain",
    ])
    expect(
      problems(
        `${minimal}queue: [{ skill: implement, then: { skill: review, when: { headroom: 50%, nope: 1 } } }]`,
      ),
    ).toEqual([
      "queue[0].then.when: headroom: a quota check goes on the rule's quota, which gates the whole chain",
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
    expect(
      problems(`${minimal}queue: [{ skill: implement, quota: { verdict: approve } }]`),
    ).toEqual(['queue[0].quota: Unrecognized key: "verdict"'])
    expect(problems(`${minimal}queue: [{ skill: implement, quota: {} }]`)).toEqual([
      'queue[0].quota: expected runs_until_reset or headroom',
    ])
    expect(problems(`${minimal}queue: [{ skill: implement, when: { headroom: 20% } }]`)).toEqual([
      "queue[0]: when was renamed on a rule: write quota, e.g. quota: { headroom: 20% }; a step's when stays",
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

  it('takes wait and gates on plan and report rules only, a rule gate without changed or a shared name', () => {
    const rules = (queue: string) =>
      problems(
        `${unlisted}gates: { risk: { skill: judge } }\nrepos: { acme/api: { gates: { routes: { command: x } } } }\nqueue:\n${queue}\n  - { skill: implement, where: { planned: true } }`,
      )
    expect(
      rules(
        '  - { skill: plan, deliver: plan, wait: false, gates: { product: { skill: judge, instructions: judges/product.md } } }\n  - { skill: story, deliver: report, wait: true, gates: { taste: { command: \'test -s "$AWAYWORK_OUT_DIR/report.md"\' } } }',
      ),
    ).toEqual([])
    const why =
      'needs deliver: plan or report; a PR is already the decision, and commits take top-level or repo gates'
    expect(rules('  - { skill: implement, deliver: pr, wait: true }')).toEqual([
      `queue[0].wait: wait ${why}`,
    ])
    expect(rules('  - { skill: implement, gates: { x: { command: x } } }')).toEqual([
      `queue[0].gates: gates ${why}`,
    ])
    expect(
      rules('  - { skill: qa, deliver: report, where: { planned: true }, wait: true }'),
    ).toContain("queue[0].wait: wait goes on the plan's rule: a task's approval is the plan's")
    expect(
      rules("  - { skill: story, deliver: report, gates: { ui: { changed: 'src/**' } } }"),
    ).toEqual([
      'queue[0].gates.ui.changed: a report has no diff: changed needs commits, in a top-level or repo gate',
    ])
    expect(
      rules(
        '  - { skill: plan, deliver: plan, gates: { risk: { skill: judge }, routes: { command: y } } }',
      ),
    ).toEqual([
      'queue[0].gates.risk: a top-level or repo gate is named risk too: name this one otherwise',
      'queue[0].gates.routes: a top-level or repo gate is named routes too: name this one otherwise',
    ])
    expect(
      rules('  - { skill: plan, deliver: plan, gates: { x: { command: x, instructions: a.md } } }'),
    ).toEqual(['queue[0].gates.x.instructions: instructions go to a judge: they need skill'])
  })

  it("refuses a report that waits on a source that can't write, and approved: true with what it names now", () => {
    const quiet = `providers: [claude: {}]\nrepos: { acme/api: {} }\nsources: { github: {}, tracker: { command: 'echo []' } }\n`
    expect(
      problems(`${quiet}queue: [{ skill: story, source: tracker, deliver: report, wait: true }]`),
    ).toEqual([
      "queue[0].wait: a report that waits posts on the item, and tracker can't write to its items; add thread: github",
    ])
    const hint = "approved names the approved post's skill now, e.g. approved: story"
    expect(problems(`${minimal}queue: [{ skill: implement, where: { approved: true } }]`)).toEqual([
      `queue[0].where.approved: ${hint}`,
    ])
    expect(
      problems(`${minimal}queue: [{ skill: implement, where: { approved: [story, prototype] } }]`),
    ).toEqual([])
  })

  it("takes a plan or a waiting report on a source that can't write with thread: github, never on Bitbucket or a task rule", () => {
    const quiet = `providers: [claude: {}]\nrepos: { acme/api: {} }\nsources: { github: {}, tracker: { command: 'echo []' } }\n`
    const task = '{ skill: implement, where: { planned: true } }'
    expect(
      problems(
        `${quiet}queue: [{ skill: plan, source: tracker, deliver: plan, thread: github }, { skill: story, source: tracker, deliver: report, wait: true, thread: github }, ${task}]`,
      ),
    ).toEqual([])
    expect(
      problems(`${quiet}queue: [{ skill: plan, source: tracker, deliver: plan }, ${task}]`),
    ).toEqual([
      "queue[0].deliver: plan posts on the item, and tracker can't write to its items; use report, or thread: github",
    ])
    expect(
      problems(
        `${quiet}queue: [{ skill: plan, deliver: plan, thread: github }, { skill: implement, where: { planned: true }, thread: github }]`,
      ),
    ).toEqual([
      "queue[1].thread: thread goes on the plan's rule: its tasks post where the plan did",
    ])
    const bitbucket = `providers: [claude: {}]\nforge: bitbucket\nrepos: { acme/api: {} }\nsources: { tracker: { command: 'echo []' } }\n`
    expect(
      problems(
        `${bitbucket}queue: [{ skill: story, source: tracker, deliver: report, thread: github }]`,
      ),
    ).toEqual([
      "queue[0].thread: thread: github opens an issue in the item's repo, and this config's repos are on Bitbucket; a custom thread host can take its posts instead",
    ])
  })

  it('takes a custom thread host that says it opens threads, on Bitbucket too', () => {
    const hosts = `providers: [claude: {}]\nforge: bitbucket\nrepos: { acme/api: {} }\nsources: { tracker: { command: 'echo []' }, notes: { command: 'echo []', write: 'cat', thread: true } }\n`
    const story = (thread: string) =>
      problems(
        `${hosts}queue: [{ skill: story, source: tracker, deliver: report, wait: true, thread: ${thread} }]`,
      )
    expect(story('notes')).toEqual([])
    const refused = (host: string) =>
      `queue[0].thread: thread is item, github or a custom source with thread: true, and ${host} isn't one`
    expect(story('tracker')).toEqual([refused('tracker')])
    expect(story('nowhere')).toEqual([refused('nowhere')])
    expect(
      problems(`providers: [claude: {}]\nsources: { notes: { command: 'echo []', thread: true } }`),
    ).toEqual(['sources.notes.thread: a thread host opens threads through its `write`: add one'])
  })

  it('refuses stack, which was removed, with what to do instead', () => {
    const chain = (rule: string) => problems(`${minimal}queue: [{ skill: implement, ${rule} }]`)
    const hint = 'stack was removed: split work into tasks with a deliver: plan rule'
    expect(chain('then: [review, { skill: fix, stack: true }]')).toEqual([
      `queue[0].then[1]: ${hint}`,
    ])
    expect(
      chain('then: { loop: [review], until: { verdict: approve }, max: 1, stack: true }'),
    ).toEqual([`queue[0].then: ${hint}`])
  })

  it('takes a custom source with a command and matches rules on its declared fields', () => {
    const cfg = minimal.replace(
      'repos: { acme/api: {} }\nsources: { github: {} }',
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
    const sources = (yaml: string) => minimal.replace('{ github: {} }', yaml)
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
    expect(problems(sources('{ github: { link: "{url}" } }'))).toEqual([
      expect.stringContaining('Unrecognized key: "link"'),
    ])
  })

  it('rejects an unknown source that has no command', () => {
    expect(problems(minimal.replace('github:', 'githb:'))).toEqual([
      'sources.githb.command: not a built-in source; a custom source needs a `command`',
    ])
  })

  it('takes bare provider names next to maps', () => {
    const cfg = parseConfig(minimal.replace('[claude: {}]', '[claude, codex: { model: gpt-5 }]'))
    expect(cfg.providers.map((p) => [p.id, p.model])).toEqual([
      ['claude', undefined],
      ['codex', 'gpt-5'],
    ])
  })

  it('takes a list of windows with optional weekdays, defaults to one, and takes none', () => {
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
    expect(problems(`${minimal}windows: []`)).toEqual([])
  })

  it('takes limits for every provider, not per provider', () => {
    const cfg = parseConfig(`${minimal}limits: { units: 6, units_per_repo: 2, unit_minutes: 90 }`)
    expect(cfg.limits).toEqual({ units: 6, units_per_repo: 2, unit_minutes: 90 })
    expect(parseConfig(minimal).limits).toEqual({})
    expect(problems(`${minimal}limits: { plan_tasks: 3 }`)).toEqual([
      'limits: plan_tasks was removed: it goes on the deliver: plan rule, e.g. { skill: plan, deliver: plan, plan_tasks: 8 }',
    ])
    expect(problems(`${minimal}limits: { unit_minutes: 0 }`)).toEqual([
      expect.stringMatching(/^limits\.unit_minutes: /),
    ])
  })

  it('takes plan_tasks on a deliver: plan rule only', () => {
    const takes = '{ skill: implement, where: { planned: true } }'
    const queue = (rule: string) => `${minimal}queue: [{ skill: plan, ${rule} }, ${takes}]`
    expect(parseConfig(queue('deliver: plan, plan_tasks: 3')).queue?.[0]?.plan_tasks).toBe(3)
    expect(parseConfig(queue('deliver: plan')).queue?.[0]?.plan_tasks).toBeUndefined()
    expect(problems(queue('deliver: report, plan_tasks: 3'))).toEqual([
      'queue[0].plan_tasks: plan_tasks needs deliver: plan: it caps the tasks of the plan the rule writes',
    ])
    expect(problems(queue('deliver: plan, plan_tasks: 0'))).toEqual([
      expect.stringMatching(/^queue\[0\]\.plan_tasks: /),
    ])
  })

  it('takes deliver: plan only where it can post and wait for your reply', () => {
    const takes = '{ skill: implement, where: { planned: true } }'
    const rule = (r: string) =>
      problems(`${minimal}queue: [{ skill: plan, deliver: plan, ${r} }, ${takes}]`)
    expect(rule('where: { type: issue }')).toEqual([])
    expect(rule('where: { state: closed, closed: { newer_than: 7d } }')).toEqual([
      'queue[0].deliver: plan waits for your reply on an open item, and this rule matches only merged or closed items; use report',
    ])
    const readOnly = minimal.replace('github: {}', 'tracker: { command: ./tracker }')
    expect(
      problems(`${readOnly}queue: [{ skill: plan, deliver: plan, source: tracker }, ${takes}]`),
    ).toEqual([
      "queue[0].deliver: plan posts on the item, and tracker can't write to its items; use report, or thread: github",
    ])
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

  it("checks a gate's judge, which never comes from the repo", async () => {
    const cfg = parseConfig(
      `${unlisted}gates: { risk: { skill: judge } }\nrepos: { acme/api: { gates: { risk: { skill: our-judge } } } }`,
    )
    expect(await unknownSkills(cfg, '/none')).toEqual([
      'repos.acme/api.gates.risk.skill: unknown skill "our-judge" (not built in, not in /none; a judge never comes from the repo)',
    ])
  })
})

describe('extends', () => {
  const base = `
windows: [{ start: '01:00', end: '07:00' }, { start: '12:00', end: '13:00' }]
limits: { units: 4, unit_minutes: 30 }
providers: [claude]
repos: { acme/api: {} }
sources: { github: {} }
`

  /** Writes each file under a fresh folder; returns the folder. */
  async function files(contents: Record<string, string>): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), 'awaywork-extends-'))
    for (const [path, text] of Object.entries(contents)) {
      await mkdir(join(dir, path, '..'), { recursive: true })
      await writeFile(join(dir, path), text)
    }
    return dir
  }

  async function error(path: string): Promise<ConfigError> {
    const e = await loadConfig(path).catch((e: unknown) => e)
    if (e instanceof ConfigError) return e
    throw new Error(`expected a ConfigError, got ${String(e)}`)
  }

  it('merges maps deeply, the role winning, and replaces lists', async () => {
    const dir = await files({
      'base.yml': base,
      'dev.yml': `extends: base.yml
windows: [{ start: '22:00', end: '06:00' }]
limits: { units: 6 }
sources: { github: { every: 15m } }
`,
    })
    const cfg = await loadConfig(join(dir, 'dev.yml'))
    expect(cfg.windows).toEqual([{ start: '22:00', end: '06:00' }])
    expect(cfg.limits).toMatchObject({ units: 6, unit_minutes: 30 })
    expect(cfg.sources.github).toMatchObject({ repos: ['acme/api'], every: '15m' })
    await writeFile(join(dir, 'base.yml'), base.replace('unit_minutes: 30', 'unit_minutes: 45'))
    expect((await loadConfig(join(dir, 'dev.yml'))).limits.unit_minutes).toBe(45)
  })

  it("resolves a base's relative paths against the base, and the role's as before", async () => {
    const dir = await files({
      'team/base.yml': `providers: [claude: { settings: claude.json }]
sources:
  github: {}
  tracker: { command: node items.mjs }
instructions: notes/team.md
repos: { acme/api: { instructions: notes/api.md } }
queue:
  - skill: fix
    instructions: [notes/fix.md]
    then: [{ skill: review, instructions: notes/review.md }, { loop: { skill: fix, instructions: notes/loop.md }, until: { verdict: approve }, max: 2 }]
`,
      'roles/dev.yml': `extends: ../team/base.yml
sources: { github: { context: { command: ./fetch.sh } } }
repos: { acme/web: { instructions: mine.md } }
`,
    })
    const team = join(dir, 'team')
    const cfg = await loadConfig(join(dir, 'roles', 'dev.yml'))
    expect(cfg.instructions).toEqual([join(team, 'notes/team.md')])
    expect(cfg.repos).toEqual({
      'acme/api': expect.objectContaining({ instructions: join(team, 'notes/api.md') }),
      'acme/web': expect.objectContaining({ instructions: 'mine.md' }),
    })
    const [rule] = cfg.queue ?? []
    expect(rule?.instructions).toEqual([join(team, 'notes/fix.md')])
    expect(rule?.then?.[0]).toMatchObject({ instructions: [join(team, 'notes/review.md')] })
    expect(rule?.then?.[1]).toMatchObject({
      loop: [{ instructions: [join(team, 'notes/loop.md')] }],
    })
    expect(cfg.providers[0]?.config).toMatchObject({ settings: join(team, 'claude.json') })
    expect(cfg.sources.tracker).toMatchObject({ dir: team })
    expect(cfg.sources.github).toMatchObject({ context: { dir: join(dir, 'roles') } })
  })

  it('refuses a URL, a base that extends another, and a missing base, naming the role', async () => {
    const dir = await files({
      'url.yml': 'extends: https://example.com/base.yml\n',
      'nested.yml': 'extends: middle.yml\n',
      'middle.yml': `extends: base.yml\n${base}`,
      'missing.yml': 'extends: nope.yml\n',
    })
    for (const [file, problem] of [
      ['url.yml', 'extends: https://example.com/base.yml: expected a path to a file, not a URL'],
      [
        'nested.yml',
        "extends: middle.yml has an extends of its own; a base can't extend another config",
      ],
      ['missing.yml', 'extends: nope.yml: file not found'],
    ] as const) {
      const e = await error(join(dir, file))
      expect([e.path, e.problems]).toEqual([join(dir, file), [problem]])
    }
  })

  it('refuses a base that is not a map, naming the base', async () => {
    const dir = await files({
      'list/base.yml': '- providers: [claude]\n',
      'list.yml': `extends: list/base.yml\n${base}`,
      'empty/base.yml': '',
      'empty.yml': `extends: empty/base.yml\n${base}`,
    })
    for (const name of ['list', 'empty']) {
      const e = await error(join(dir, `${name}.yml`))
      expect([e.path, e.problems]).toEqual([
        join(dir, name, 'base.yml'),
        ['expected a map of config keys'],
      ])
    }
  })

  it('names the file each problem comes from', async () => {
    const dir = await files({
      'broken/base.yml': 'providers: [claude\n',
      'broken.yml': 'extends: broken/base.yml\n',
      'bad/base.yml': base.replace("'12:00'", "'noon'").replace('limits:', 'limit: 1\nlimits:'),
      'bad.yml': 'extends: bad/base.yml\n',
      'both.yml': 'extends: bad/base.yml\nlimits: { units: none }\n',
      'over.yml': "extends: bad/base.yml\nwindows: [{ start: '01:00', end: '01:00' }]\nlimit: 2\n",
      'step/base.yml': `${base}queue: [{ skill: fix, then: { skill: review, max: 2 } }]\n`,
      'step.yml': 'extends: step/base.yml\n',
    })
    const broken = await error(join(dir, 'broken.yml'))
    expect(broken.path).toBe(join(dir, 'broken/base.yml'))
    expect(broken.problems[0]).toMatch(/flow sequence/i)
    const bad = await error(join(dir, 'bad.yml'))
    expect([bad.path, bad.problems]).toEqual([
      join(dir, 'bad/base.yml'),
      [expect.stringMatching(/^windows\[1\]\.start: /), 'Unrecognized key: "limit"'],
    ])
    const both = await error(join(dir, 'both.yml'))
    expect([both.path, both.problems]).toEqual([
      join(dir, 'bad/base.yml'),
      [
        expect.stringMatching(/^windows\[1\]\.start: /),
        `${join(dir, 'both.yml')}: limits.units: Invalid input: expected number, received string`,
        'Unrecognized key: "limit"',
      ],
    ])
    expect((await error(join(dir, 'step.yml'))).path).toBe(join(dir, 'step/base.yml'))
    const over = await error(join(dir, 'over.yml'))
    expect([over.path, over.problems]).toEqual([
      join(dir, 'over.yml'),
      ['windows[0]: start and end must differ', 'Unrecognized key: "limit"'],
    ])
  })

  it("names the role for an item of a list it replaced, though the base's item sets that key", async () => {
    const dir = await files({
      'team/base.yml': `${base}queue: [{ skill: fix, source: github, where: { type: pr } }]\n`,
      'rule.yml': 'extends: team/base.yml\nqueue: [{ source: github, where: { type: pr } }]\n',
      'window.yml': "extends: team/base.yml\nwindows: [{ start: '02:00' }]\n",
    })
    for (const file of ['rule.yml', 'window.yml'])
      expect((await error(join(dir, file))).path).toBe(join(dir, file))
  })

  it('names the file of each unknown key in one map', async () => {
    const dir = await files({
      'typo/base.yml': base.replace('limits: {', 'foo: 1\nlimits: { unitz: 2,'),
      'typo.yml': 'extends: typo/base.yml\nbar: 2\nlimits: { units: 3, unitx: 4 }\n',
    })
    const e = await error(join(dir, 'typo.yml'))
    const role = join(dir, 'typo.yml')
    expect([e.path, e.problems.toSorted()]).toEqual([
      join(dir, 'typo/base.yml'),
      [
        `${role}: Unrecognized key: "bar"`,
        `${role}: limits: Unrecognized key: "unitx"`,
        'Unrecognized key: "foo"',
        'limits: Unrecognized key: "unitz"',
      ].toSorted(),
    ])
  })
})

describe('awaywork config path', () => {
  afterEach(() => {
    process.exitCode = undefined
    vi.restoreAllMocks()
    vi.unstubAllEnvs()
  })

  async function path(...args: string[]) {
    const out = vi.spyOn(console, 'log').mockImplementation(() => {})
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    const program = new Command().option('-c, --config <path>')
    configCommand(program)
    await program.parseAsync([...args, 'config', 'path'], { from: 'user' })
    return { out: out.mock.calls, err: err.mock.calls, code: process.exitCode }
  }

  it('prints the config in use, from --config or else $AWAYWORK_CONFIG, and exits 1 when it is missing', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'awaywork-path-'))
    const there = join(dir, 'config.yml')
    const missing = join(dir, 'missing.yml')
    await writeFile(there, minimal)
    vi.stubEnv('AWAYWORK_CONFIG', missing)
    expect(await path('--config', there)).toEqual({ out: [[there]], err: [], code: undefined })
    vi.restoreAllMocks()
    expect(await path()).toEqual({
      out: [[missing]],
      err: [[`${missing} not found; awaywork init writes one`]],
      code: 1,
    })
  })

  it('config explain reads the rules past a broken SKILL.md, without a stack', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'awaywork-explain-'))
    const there = join(dir, 'config.yml')
    await writeFile(
      there,
      `${minimal}queue:\n  - { skill: review, source: github, where: { type: pr } }\n`,
    )
    await mkdir(join(dir, 'skills/broken'), { recursive: true })
    await writeFile(join(dir, 'skills/broken/SKILL.md'), '---\nname: [unclosed\n---\n')
    const out = vi.spyOn(console, 'log').mockImplementation(() => {})
    const program = new Command().option('-c, --config <path>')
    configCommand(program)
    await program.parseAsync(['--config', there, 'config', 'explain'], { from: 'user' })
    expect(JSON.parse(out.mock.calls[0]?.[0] as string)).toMatchObject({
      valid: true,
      rules: [{ skill: 'review', leaves: 'report' }],
    })
  })
})
