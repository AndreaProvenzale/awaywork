import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { notifyRun, notifyUnit } from '../src/worker/notify.js'

it('runs the command in a shell with the run event, report path and run id in its env', async () => {
  const out = join(await mkdtemp(join(tmpdir(), 'awaywork-notify-')), 'out.txt')
  const command = `echo "$AWAYWORK_EVENT $AWAYWORK_RUN_ID $AWAYWORK_REPORT $HOME" > '${out}'`
  const failure = await notifyRun(command, { path: '/runs/1/report.md', runId: '1' })
  expect(failure).toBeUndefined()
  expect(await readFile(out, 'utf8')).toBe(`run 1 /runs/1/report.md ${process.env.HOME}\n`)
})

it('returns why a failing command failed, with its output, instead of throwing', async () => {
  const failure = await notifyRun('echo no route >&2; exit 7', { path: 'r.md', runId: '1' })
  expect(failure).toMatch(/exit code 7/)
  expect(failure).toMatch(/\nno route$/)
})

it('runs the command with the unit event, its unit, status and PR in its env, and none of what is absent', async () => {
  const out = join(await mkdtemp(join(tmpdir(), 'awaywork-notify-unit-')), 'out.txt')
  const command = `echo "$AWAYWORK_EVENT $AWAYWORK_UNIT $AWAYWORK_SKILL $AWAYWORK_STATUS $AWAYWORK_PR_URL|$AWAYWORK_REPORT" > '${out}'`
  const unit = { runId: '1', id: 'a-1', skill: 'fix', status: 'done' }
  expect(await notifyUnit(command, { ...unit, pr: 'https://x/pull/2' })).toBeUndefined()
  expect(await readFile(out, 'utf8')).toBe('unit a-1 fix done https://x/pull/2|\n')
})

it('gives the unit event one line per item, the repo, verdict and output folder when present', async () => {
  const out = join(await mkdtemp(join(tmpdir(), 'awaywork-notify-unit-')), 'out.txt')
  const command = `echo "$AWAYWORK_ITEM_URL|$AWAYWORK_ITEM_KEY|$AWAYWORK_SOURCE|$AWAYWORK_REPO|$AWAYWORK_VERDICT|$AWAYWORK_OUT_DIR" > '${out}'`
  const unit = { runId: '1', id: 'a-1', skill: 'fix', status: 'done' }
  const items = [
    { url: 'https://x/1', key: 'acme#1', source: 'github' },
    { url: 'https://x/2', key: 'acme#2', source: 'github' },
  ]
  await notifyUnit(command, { ...unit, items, repo: 'acme/api', verdict: 'pass', outDir: '/o' })
  expect(await readFile(out, 'utf8')).toBe(
    'https://x/1\nhttps://x/2|acme#1\nacme#2|github\ngithub|acme/api|pass|/o\n',
  )
  await notifyUnit(command, unit)
  expect(await readFile(out, 'utf8')).toBe('|||||\n')
})

it.each(['sleep 30', 'sleep 30; true'])(
  "stops a running unit event's command and what it started on abort: %s",
  async (command) => {
    const unit = { runId: '1', id: 'a-1', skill: 'fix', status: 'done' }
    const started = Date.now()
    expect(await notifyUnit(command, unit, AbortSignal.timeout(100))).toMatch(/canceled/)
    expect(Date.now() - started).toBeLessThan(5000)
  },
)
