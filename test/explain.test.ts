import { describe, expect, it } from 'vitest'
import { explainConfig } from '#cli/commands/explain'
import { builtinSkills, type SkillCatalog } from '#core/skills'

const base = 'providers: [claude]\nrepos: { a/b: {} }\nsources: { github: {} }\n'
const builtin: SkillCatalog = { builtin: builtinSkills }

function rule(where: string, extra = '', skill = 'fix', skills = builtin) {
  const planned = '  - { skill: implement, where: { planned: true } }\n'
  const text = `${base}queue:\n  - { skill: ${skill}, source: github, where: ${where}${extra} }\n${planned}`
  const explained = explainConfig(text, 'config.yml', skills)
  if (!explained.valid) throw new Error(explained.problems.join('\n'))
  return explained.rules[0]
}

describe('explainConfig', () => {
  it.each([
    ['{ type: pr, mine: true, behind: { gt: 0 } }', 'my PRs, behind their base'],
    ['{ type: pr, draft: false }', 'PRs, not draft'],
    ['{ type: pr, changed_lines: { lte: 400 } }', 'PRs, changed lines at most 400'],
    ['{ type: pr, updated: { older_than: 3d } }', 'PRs, updated over 3d ago'],
    ['{ type: issue, title: { matches: "^bug" } }', 'issues, title matching /^bug/'],
    [
      '{ type: pr, any: [{ draft: true }, { checks: failing }] }',
      'PRs, any of: draft or checks failing',
    ],
    ['{ type: pr, label: { not: wip } }', 'PRs, label not wip'],
    ['{ type: pr, label: [wip, draft] }', 'PRs, label wip, draft'],
    ['{ type: pr, author: { not: dependabot } }', 'PRs, author not dependabot'],
    ['{ type: pr, repo: { matches: "^acme" } }', 'PRs, repo matching /^acme/'],
    ['{ type: pr, mine: false }', 'PRs, not mine'],
    ['{ type: pr, mine: true }', 'my PRs'],
  ])('says %s in words', (where, words) => {
    expect(rule(where)?.takes).toBe(words)
  })

  it.each<[string, string, SkillCatalog | undefined, string]>([
    ['fix', '', undefined, 'draft PR'],
    ['fix', ', deliver: pr', undefined, 'PR'],
    ['review', '', undefined, 'report'],
    ['review', ', deliver: draft_pr', undefined, 'report'],
    ['review', ', deliver: pending_review', undefined, 'pending review'],
    ['triage', '', { ...builtin, user: { triage: { deliver: 'report' } } }, 'report'],
    ['review', '', { ...builtin, user: { review: {} } }, 'draft PR'],
    // The plan skips its every item: its gates could never run.
    ['review', ', gates: { own: { command: x } }', undefined, 'nothing'],
    ['review', ', deliver: pr, gates: { own: { command: x } }', undefined, 'nothing'],
    ['review', ', deliver: report, gates: { own: { command: x } }', undefined, 'report'],
  ])('says %s%s leaves what the run would', (skill, extra, skills, leaves) => {
    expect(rule('{ type: pr }', extra, skill, skills)?.leaves).toBe(leaves)
  })

  it.each([
    [', deliver: plan', true],
    [', deliver: plan, wait: false', false],
    [', deliver: plan, wait: false, gates: { product: { skill: judge } }', true],
    [', deliver: report, wait: false, gates: { product: { skill: judge } }', true],
    [', deliver: report, wait: true', true],
    [', deliver: report', false],
    [', deliver: pr, gates: { proof: { command: x } }', false],
  ])('says whether a rule with%s can stop for you', (extra, waits) => {
    expect(rule('{ type: issue }', extra, 'plan')?.waits).toBe(waits)
  })

  it('gives each rule its line in the file', () => {
    expect(rule('{ type: pr }')?.line).toBe(5)
  })

  it('reports a config that does not validate instead of throwing', () => {
    const said = explainConfig('providers: []\n', 'config.yml', builtin)
    expect(said.valid).toBe(false)
  })
})
