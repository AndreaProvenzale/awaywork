import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { afterUnit, notify } from '../src/worker/notify.js'

it('runs the command in a shell with the report path and run id in its env', async () => {
  const out = join(await mkdtemp(join(tmpdir(), 'nightshift-notify-')), 'out.txt')
  const command = `echo "$NIGHTSHIFT_RUN_ID $NIGHTSHIFT_REPORT $HOME" > '${out}'`
  const failure = await notify(command, { path: '/runs/1/report.md', runId: '1' })
  expect(failure).toBeUndefined()
  expect(await readFile(out, 'utf8')).toBe(`1 /runs/1/report.md ${process.env.HOME}\n`)
})

it('returns why a failing command failed, with its output, instead of throwing', async () => {
  const failure = await notify('echo no route >&2; exit 7', { path: 'r.md', runId: '1' })
  expect(failure).toMatch(/exit code 7/)
  expect(failure).toMatch(/\nno route$/)
})

it('runs the after_unit command with the unit, status and PR in its env, and none of what is absent', async () => {
  const out = join(await mkdtemp(join(tmpdir(), 'nightshift-after-unit-')), 'out.txt')
  const command = `echo "$NIGHTSHIFT_UNIT $NIGHTSHIFT_SKILL $NIGHTSHIFT_STATUS $NIGHTSHIFT_PR_URL|$NIGHTSHIFT_REPORT" > '${out}'`
  const unit = { runId: '1', id: 'a-1', skill: 'fix-ci', status: 'done' }
  expect(await afterUnit(command, { ...unit, pr: 'https://x/pull/2' })).toBeUndefined()
  expect(await readFile(out, 'utf8')).toBe('a-1 fix-ci done https://x/pull/2|\n')
})

it('stops a running after_unit command on abort', async () => {
  const unit = { runId: '1', id: 'a-1', skill: 'fix-ci', status: 'done' }
  const started = Date.now()
  expect(await afterUnit('sleep 30', unit, AbortSignal.timeout(100))).toMatch(/canceled/)
  expect(Date.now() - started).toBeLessThan(5000)
})
