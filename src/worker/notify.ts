import { execa } from 'execa'
import { killGroupWhenDone } from '../core/group.js'

const TIMEOUT_MS = 60_000

/**
 * Runs a user command in a shell with `env` added, stopped on `signal`; returns why it failed, never throws.
 * Like setup, it runs in its own process group, killed when it exits or is stopped.
 */
async function runHook(
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

/** Runs the notify command for the run's end, with the morning report in its env. */
export function notifyRun(
  command: string,
  report: { path: string; runId: string },
): Promise<string | undefined> {
  return runHook(command, {
    AWAYWORK_EVENT: 'run',
    AWAYWORK_REPORT: report.path,
    AWAYWORK_RUN_ID: report.runId,
  })
}

/** Runs the notify command for one step of a finished unit, with its result in its env. */
export function notifyUnit(
  command: string,
  unit: {
    runId: string
    id: string
    skill: string
    status: string
    items?: { url: string; key: string; source: string }[]
    repo?: string
    verdict?: string
    pr?: string
    report?: string
    outDir?: string
  },
  signal?: AbortSignal,
): Promise<string | undefined> {
  return runHook(
    command,
    {
      AWAYWORK_EVENT: 'unit',
      AWAYWORK_RUN_ID: unit.runId,
      AWAYWORK_UNIT: unit.id,
      AWAYWORK_SKILL: unit.skill,
      AWAYWORK_STATUS: unit.status,
      ...(unit.items && {
        AWAYWORK_ITEM_URL: unit.items.map((i) => i.url).join('\n'),
        AWAYWORK_ITEM_KEY: unit.items.map((i) => i.key).join('\n'),
        AWAYWORK_SOURCE: unit.items.map((i) => i.source).join('\n'),
      }),
      ...(unit.repo && { AWAYWORK_REPO: unit.repo }),
      ...(unit.verdict && { AWAYWORK_VERDICT: unit.verdict }),
      ...(unit.pr && { AWAYWORK_PR_URL: unit.pr }),
      ...(unit.report && { AWAYWORK_REPORT: unit.report }),
      ...(unit.outDir && { AWAYWORK_OUT_DIR: unit.outDir }),
    },
    signal,
  )
}
