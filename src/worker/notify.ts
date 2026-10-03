import { execa } from 'execa'

const TIMEOUT_MS = 60_000

/** Runs a user command in a shell with `env` added; returns why it failed, never throws. */
export async function runHook(
  command: string,
  env: Record<string, string>,
): Promise<string | undefined> {
  const result = await execa(command, {
    shell: true,
    env,
    stdin: 'ignore',
    timeout: TIMEOUT_MS,
    reject: false,
    all: true,
  })
  if (!result.failed) return undefined
  const why = result.timedOut ? `timed out after ${TIMEOUT_MS / 1000}s` : result.shortMessage
  return [why, result.all?.trim()].filter(Boolean).join('\n')
}

/** Runs the notify command with the report in its env. */
export function notify(
  command: string,
  report: { path: string; runId: string },
): Promise<string | undefined> {
  return runHook(command, { NIGHTSHIFT_REPORT: report.path, NIGHTSHIFT_RUN_ID: report.runId })
}

/** Runs the after_unit command with one unit's result in its env. */
export function afterUnit(
  command: string,
  unit: { runId: string; id: string; skill: string; status: string; pr?: string; report?: string },
): Promise<string | undefined> {
  return runHook(command, {
    NIGHTSHIFT_RUN_ID: unit.runId,
    NIGHTSHIFT_UNIT: unit.id,
    NIGHTSHIFT_SKILL: unit.skill,
    NIGHTSHIFT_STATUS: unit.status,
    ...(unit.pr && { NIGHTSHIFT_PR_URL: unit.pr }),
    ...(unit.report && { NIGHTSHIFT_REPORT: unit.report }),
  })
}
