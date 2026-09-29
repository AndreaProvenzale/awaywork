import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { notify } from '../src/worker/notify.js'

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
