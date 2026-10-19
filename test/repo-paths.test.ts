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

  it('accepts owner/name', () => {
    expect(parse('acme/app')).toBe(true)
  })

  it('rejects a bare name and nested groups', () => {
    expect(parse('app')).toBe(false)
    expect(parse('group/sub/project')).toBe(false)
  })
})

describe('command source repo field', () => {
  const repo = commandSource('t', { ...commandConfig.parse({ command: 'x' }), dir: '.' }).fields
    .repo

  it('accepts owner/name and rejects a bare name and nested groups', () => {
    expect(repo?.safeParse('acme/app').success).toBe(true)
    expect(repo?.safeParse('app').success).toBe(false)
    expect(repo?.safeParse('group/sub/project').success).toBe(false)
  })
})

describe('jira repo_map', () => {
  const parse = (repo: string) =>
    configSchema.safeParse({
      providers: ['claude'],
      sources: { jira: { site: 'x.atlassian.net', email: 'a@b.c', repo_map: { ENG: repo } } },
    }).success

  it('accepts owner/name and rejects a bare name and nested groups', () => {
    expect(parse('acme/app')).toBe(true)
    expect(parse('app')).toBe(false)
    expect(parse('group/sub/project')).toBe(false)
  })
})
