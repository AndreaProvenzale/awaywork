import { chmod, mkdir, mkdtemp, readFile, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { parseConfig } from '../src/config/load.js'
import type { Item } from '../src/core/types.js'
import { fetchContexts, runContext } from '../src/worker/context.js'
import { fakeItem } from './fakes/items.js'

const item = { key: 'ACME-1', url: 'https://x/1', title: 'Crash' } as Item

async function run(command: string, env: NodeJS.ProcessEnv = {}) {
  const root = await mkdtemp(join(tmpdir(), 'awaywork-context-'))
  const extra = join(root, 'extra')
  const logged: string[] = []
  const failed = await runContext(
    command,
    item,
    root,
    extra,
    { PATH: process.env.PATH, ...env },
    (l) => logged.push(l),
    { secrets: ['TOKEN'] },
  )
  return { extra, failed, logged }
}

it("copies what it wrote to AWAYWORK_CONTEXT_DIR into extra/, with the item's key, url and JSON file in its env", async () => {
  const { extra, failed } = await run(
    'cd "$AWAYWORK_CONTEXT_DIR"; echo "$AWAYWORK_ITEM_KEY $AWAYWORK_ITEM_URL" > out.md; mkdir sub; cp "$AWAYWORK_ITEM_FILE" sub/item.json',
  )
  expect(failed).toBeUndefined()
  expect(await readFile(join(extra, 'out.md'), 'utf8')).toBe('ACME-1 https://x/1\n')
  expect(JSON.parse(await readFile(join(extra, 'sub/item.json'), 'utf8')).title).toBe('Crash')
})

it('drops what a failing command wrote and masks its secrets in the log', async () => {
  const { extra, failed, logged } = await run(
    'echo "$TOKEN" > "$AWAYWORK_CONTEXT_DIR/leak.md"; echo "$TOKEN"; exit 3',
    { TOKEN: 's3cret' },
  )
  expect(failed).toMatch(/^context for ACME-1 failed: .*exit code 3/)
  expect(logged.join()).not.toContain('s3cret')
  await expect(stat(extra)).rejects.toThrow()
})

it('drops output over the size limit', async () => {
  const { extra, failed } = await run('head -c 1100000 /dev/zero > "$AWAYWORK_CONTEXT_DIR/big.bin"')
  expect(failed).toMatch(/over the 1000000 limit/)
  await expect(stat(extra)).rejects.toThrow()
})

it("doesn't copy output holding a symlink or a FIFO", async () => {
  for (const command of ['ln -s /etc/passwd link', 'mkfifo pipe']) {
    const { extra, failed } = await run(`cd "$AWAYWORK_CONTEXT_DIR"; echo hi > ok.md; ${command}`)
    expect(failed).toMatch(/is not a regular file/)
    await expect(stat(extra)).rejects.toThrow()
  }
})

it("doesn't copy through an AWAYWORK_CONTEXT_DIR replaced by a symlink", async () => {
  const { extra, failed } = await run(
    'mkdir target; echo hi > target/ok.md; rmdir "$AWAYWORK_CONTEXT_DIR"; ln -s "$PWD/target" "$AWAYWORK_CONTEXT_DIR"',
  )
  expect(failed).toMatch(/AWAYWORK_CONTEXT_DIR is not a folder/)
  await expect(stat(extra)).rejects.toThrow()
})

it("runs each item's command from the config's folder, not the clone, with its own secrets only", async () => {
  const root = await mkdtemp(join(tmpdir(), 'awaywork-context-'))
  const [configDir, clone] = [join(root, 'config'), join(root, 'clone')]
  for (const [dir, says] of [
    [configDir, 'config'],
    [clone, 'clone'],
  ] as const) {
    await mkdir(dir)
    const script = join(dir, 'fetch.sh')
    await writeFile(
      script,
      `#!/bin/sh\necho "${says} $AWAYWORK_ITEM_KEY $SENTRY_TOKEN $OTHER" > "$AWAYWORK_CONTEXT_DIR/sentry.md"\n`,
    )
    await chmod(script, 0o755)
  }
  await fetchContexts([fakeItem({ source: 'github' }), fakeItem({ key: 'NONE-1' })], clone, {
    config: parseConfig(`
providers: [claude: {}]
sources:
  github:
    repos: [acme/*]
    context: { command: ./fetch.sh, secrets: [SENTRY_TOKEN] }
`),
    configDir,
    env: { PATH: process.env.PATH, SENTRY_TOKEN: 'tok', OTHER: 'nope' },
    secrets: ['SENTRY_TOKEN', 'OTHER'],
    log: () => {},
  })
  expect(await readFile(join(clone, '.away/context/fake-1/extra/sentry.md'), 'utf8')).toBe(
    'config FAKE-1 tok \n',
  )
  await expect(stat(join(clone, '.away/context/none-1'))).rejects.toThrow()
})
