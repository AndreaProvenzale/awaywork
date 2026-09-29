import { execa } from 'execa'

const TIMEOUT_MS = 60_000

/** Runs the notify command with the report in its env; returns why it failed, never throws. */
export async function notify(
  command: string,
  report: { path: string; runId: string },
): Promise<string | undefined> {
  const result = await execa(command, {
    shell: true,
    env: { NIGHTSHIFT_REPORT: report.path, NIGHTSHIFT_RUN_ID: report.runId },
    stdin: 'ignore',
    timeout: TIMEOUT_MS,
    reject: false,
    all: true,
  })
  if (!result.failed) return undefined
  const why = result.timedOut ? `timed out after ${TIMEOUT_MS / 1000}s` : result.shortMessage
  return [why, result.all?.trim()].filter(Boolean).join('\n')
}
