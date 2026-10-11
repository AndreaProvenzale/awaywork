import type { Item } from './types.js'

export const defaultBranch = 'away/{key}'

/** `{key}` in its own case with runs outside [A-Za-z0-9._-] as `-`; `{title}` as a lowercase slug of at most 40 characters. */
export function renderBranch(template: string, item: Pick<Item, 'key' | 'title'>): string {
  const key = item.key.replace(/[^A-Za-z0-9._-]+/g, '-')
  const title = item.title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+/, '')
    .slice(0, 40)
    .replace(/-+$/, '')
  return template.replaceAll('{key}', key).replaceAll('{title}', title)
}

/** Why a template using only these placeholders, and at least one of them, isn't one. */
export function placeholderProblem(template: string, names: string[]): string | undefined {
  const unknown = template.match(/\{[^}]*\}/g)?.find((p) => !names.includes(p.slice(1, -1)))
  if (unknown) return `unknown placeholder ${unknown}`
  const all = names.map((n) => `{${n}}`)
  if (!all.some((p) => template.includes(p)))
    return `must contain ${all.slice(0, -1).join(', ')} or ${all.at(-1)}`
}

/** Why a template can't make branch names, or undefined when it can. */
export function templateProblem(template: string): string | undefined {
  const problem = placeholderProblem(template, ['key', 'title'])
  if (problem) return problem
  const sample = renderBranch(template, { key: 'ABC-1', title: 'Sample title' })
  if (!isValidRef(sample)) return `renders an invalid branch name, e.g. "${sample}"`
}

/** Git's rules for a branch name (git check-ref-format). */
export function isValidRef(name: string): boolean {
  return (
    name !== '' &&
    name !== '@' &&
    !/[\p{Cc}\s~^:?*[\\]|\.\.|@\{|\/\/|^\/|\/$|\.$|^-/u.test(name) &&
    name.split('/').every((part) => !part.startsWith('.') && !part.endsWith('.lock'))
  )
}
