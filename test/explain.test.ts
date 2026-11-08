import { describe, expect, it } from 'vitest'
import { explainConfig } from '../src/cli/explain.js'

const base = 'providers: [claude]\nsources: { github: { repos: [a/b] } }\n'

function rule(where: string, extra = '') {
  const text = `${base}queue:\n  - { skill: fix, source: github, where: ${where}${extra} }\n`
  const explained = explainConfig(text, 'config.yml')
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
  ])('says %s in words', (where, words) => {
    expect(rule(where)?.takes).toBe(words)
  })

  it('gives each rule its lines in the file', () => {
    expect(rule('{ type: pr }')?.lines).toEqual([4, 4])
  })

  it('reports a config that does not validate instead of throwing', () => {
    const said = explainConfig('providers: []\n', 'config.yml')
    expect(said.valid).toBe(false)
  })
})
