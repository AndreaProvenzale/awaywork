import type { Unit } from './types'

/** Whether a `trust` list names an author: `*`, `collaborators` for write access or org membership, or their login as GitHub shows it (`name[bot]` for a bot). */
export const trusts = (trust: string[], author: string | undefined, collaborator: boolean) => {
  const names = trust.map((name) => name.toLowerCase())
  return (
    names.includes('*') ||
    (collaborator && names.includes('collaborators')) ||
    (author !== undefined && names.includes(author.toLowerCase()))
  )
}

/** Whether a unit runs without your grants (`network`, `writable`, MCP servers, serve): its PR, or an issue it works on, comes from an author off `trust`. */
export const withholdsGrants = (unit: Pick<Unit, 'untrusted' | 'untrustedText'>) =>
  unit.untrusted || !!unit.untrustedText
