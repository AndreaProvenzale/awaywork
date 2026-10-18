import { describe, expect, it } from 'vitest'
import { configSchema } from '../src/config/schema.js'

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
