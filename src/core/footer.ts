const marker = '<!-- night-shift'

/** Appended to every PR body night-shift opens; it discloses the author and marks the PR as ours. */
export function footer(runId: string): string {
  return `---\n${marker} run=${runId} -->\nOpened by night-shift (run \`${runId}\`): a coding agent worked on this unattended. Review it like any other contribution.`
}

export const isOurs = (body: string | null | undefined): boolean => !!body?.includes(marker)
