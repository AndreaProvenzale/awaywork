/** Whether a `trust` list names an author: `*`, `collaborators` for write access or org membership, or their login as GitHub shows it (`name[bot]` for a bot). */
export const trusts = (trust: string[], author: string | undefined, collaborator: boolean) => {
  const names = trust.map((name) => name.toLowerCase())
  return (
    names.includes('*') ||
    (collaborator && names.includes('collaborators')) ||
    (author !== undefined && names.includes(author.toLowerCase()))
  )
}
