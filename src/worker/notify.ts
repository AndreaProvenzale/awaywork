import { execa } from 'execa'
import { killGroupWhenDone } from '../core/group.js'

const TIMEOUT_MS = 60_000

/**
 * Runs a user command in a shell with `env` added, stopped on `signal`; returns why it failed, never throws.
 * Like setup, it runs in its own process group, killed when it exits or is stopped.
 */
export async function runHook(
  command: string,
  env: Record<string, string>,
  signal?: AbortSignal,
): Promise<string | undefined> {
  const timeout = AbortSignal.timeout(TIMEOUT_MS)
  const stop = signal ? AbortSignal.any([signal, timeout]) : timeout
  const subprocess = execa(command, {
    shell: true,
    env,
    stdin: 'ignore',
    killDescendants: true,
    reject: false,
    all: true,
  })
  const release = killGroupWhenDone(subprocess, stop)
  const result = await subprocess
  release()
  if (!result.failed) return undefined
  const why = !stop.aborted
    ? result.shortMessage
    : signal?.aborted
      ? 'canceled'
      : `timed out after ${TIMEOUT_MS / 1000}s`
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
  signal?: AbortSignal,
): Promise<string | undefined> {
  return runHook(
    command,
    {
      NIGHTSHIFT_RUN_ID: unit.runId,
      NIGHTSHIFT_UNIT: unit.id,
      NIGHTSHIFT_SKILL: unit.skill,
      NIGHTSHIFT_STATUS: unit.status,
      ...(unit.pr && { NIGHTSHIFT_PR_URL: unit.pr }),
      ...(unit.report && { NIGHTSHIFT_REPORT: unit.report }),
    },
    signal,
  )
}
