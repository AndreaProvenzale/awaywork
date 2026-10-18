import { describe, expect, it } from 'vitest'
import { configSchema } from '../src/config/schema.js'
import { commandConfig, commandSource } from '../src/sources/command.js'

describe('repos keys', () => {
  const parse = (key: string) =>
    configSchema.safeParse({
      providers: ['claude'],
      sources: { github: { repos: ['a/b'] } },
      repos: { [key]: {} },
    }).success

  it('accepts owner/name and nested groups', () => {
    expect(parse('acme/app')).toBe(true)
    expect(parse('group/sub/project')).toBe(true)
  })

  it('rejects a bare name', () => {
    expect(parse('app')).toBe(false)
  })
})

describe('command source repo field', () => {
  const repo = commandSource('t', { ...commandConfig.parse({ command: 'x' }), dir: '.' }).fields
    .repo

  it('accepts nested groups and rejects a bare name', () => {
    expect(repo?.safeParse('group/sub/project').success).toBe(true)
    expect(repo?.safeParse('app').success).toBe(false)
  })
})

describe('jira repo_map', () => {
  const parse = (repo: string) =>
    configSchema.safeParse({
      providers: ['claude'],
      sources: { jira: { site: 'x.atlassian.net', email: 'a@b.c', repo_map: { ENG: repo } } },
    }).success

  it('accepts nested groups and rejects a bare name', () => {
    expect(parse('group/sub/project')).toBe(true)
    expect(parse('app')).toBe(false)
  })
})
