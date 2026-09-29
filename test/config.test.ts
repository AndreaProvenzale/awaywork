import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { ConfigError, configPath, parseConfig } from '../src/config/load.js'
import { unknownSkills } from '../src/config/skills.js'

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
  })
})
