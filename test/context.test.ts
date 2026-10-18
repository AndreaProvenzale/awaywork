import { mkdtemp, readFile, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import type { Item } from '../src/core/types.js'
import { runContext } from '../src/worker/context.js'

const item = { key: 'ACME-1', url: 'https://x/1', title: 'Crash' } as Item

async function run(command: string, env: NodeJS.ProcessEnv = {}) {
  const extra = join(await mkdtemp(join(tmpdir(), 'awaywork-context-')), 'extra')
  const logged: string[] = []
  const failed = await runContext(
    command,
    item,
    extra,
    { PATH: process.env.PATH, ...env },
    (l) => logged.push(l),
    { secrets: ['TOKEN'] },
  )
  return { extra, failed, logged }
}

it("runs in extra/ with the item's key, url and JSON file in its env", async () => {
  const { extra, failed } = await run(
    'echo "$AWAYWORK_ITEM_KEY $AWAYWORK_ITEM_URL" > out.md; cp "$AWAYWORK_ITEM_FILE" item.json',
  )
  expect(failed).toBeUndefined()
  expect(await readFile(join(extra, 'out.md'), 'utf8')).toBe('ACME-1 https://x/1\n')
  expect(JSON.parse(await readFile(join(extra, 'item.json'), 'utf8')).title).toBe('Crash')
})

it('drops what a failing command wrote and masks its secrets in the log', async () => {
  const { extra, failed, logged } = await run('echo "$TOKEN" > leak.md; echo "$TOKEN"; exit 3', {
    TOKEN: 's3cret',
  })
  expect(failed).toMatch(/^context for ACME-1 failed: .*exit code 3/)
  expect(logged.join()).not.toContain('s3cret')
  await expect(stat(extra)).rejects.toThrow()
})

it('drops output over the size limit', async () => {
  const { extra, failed } = await run('head -c 1100000 /dev/zero > big.bin')
  expect(failed).toMatch(/over the 1000000 limit/)
  await expect(stat(extra)).rejects.toThrow()
})

it('drops output holding a symlink', async () => {
  const { failed } = await run('ln -s /etc/passwd link')
  expect(failed).toMatch(/link is a symlink/)
})
