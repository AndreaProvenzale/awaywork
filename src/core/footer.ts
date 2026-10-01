const marker = '<!-- night-shift'

/** Appended to every PR body night-shift opens; it discloses the author and marks the PR as ours. */
export function footer(runId: string): string {
  return `---\n${marker} run=${runId} -->\nOpened by night-shift (run \`${runId}\`): a coding agent worked on this unattended. Review it like any other contribution.`
}

export const isOurs = (body: string | null | undefined): boolean => !!body?.includes(marker)

/** The trailer every commit night-shift publishes carries, keyed `Night-shift: <run id>`. */
export const trailerKey = 'Night-shift'

/** Whether night-shift pushed `message`'s commit onto the PR, not opened the PR with it. */
export function isPushedCommit(
  message: string | undefined,
  body: string | null | undefined,
): boolean {
  const run = message?.match(new RegExp(`^${trailerKey}: (\\S+)`, 'm'))?.[1]
  return !!run && !body?.includes(`${marker} run=${run} -->`)
}
