import { parse } from 'yaml'
import type { Deliver } from './types.js'

export interface SkillMeta {
  deliver?: Deliver
  description?: string
}
export type Origin = 'user' | 'repo' | 'builtin'
export type SkillCatalog = Partial<Record<Origin, Record<string, SkillMeta>>>

export const builtinSkills: Record<string, SkillMeta> = {
  fix: {},
  plan: { deliver: 'report' },
  implement: {},
  review: { deliver: 'report' },
}

const lookupOrder: Origin[] = ['user', 'repo', 'builtin']

/** First hit in user, in-repo, then built-in skills; an absent `repo` catalog means it isn't known yet. */
export function resolveSkill(
  name: string,
  catalog: SkillCatalog,
): { origin: Origin; meta: SkillMeta } | undefined {
  for (const origin of lookupOrder) {
    const meta = catalog[origin]?.[name]
    if (meta) return { origin, meta }
  }
}

/** Reads `description` and `metadata.deliver` from a SKILL.md frontmatter. */
export function parseSkill(text: string): SkillMeta {
  const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text)?.[1]
  const { description, metadata } = (frontmatter && parse(frontmatter)) || {}
  const deliver = metadata?.deliver
  return {
    ...((deliver === 'draft_pr' || deliver === 'report') && { deliver }),
    ...(typeof description === 'string' && { description }),
  }
}
