import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { asWorker, isolate, sudoersLines, WORKER, workerRoot } from '../src/core/launch.js'

// A file of its own: bin() keeps the first sudo it finds, here the fake one.
it('chowns a clone only as the sudoers lines allow, a folder straight under /tmp', async () => {
  const fakes = await mkdtemp(join(tmpdir(), 'awaywork-sudo-'))
  const calls = join(fakes, 'calls')
  await writeFile(join(fakes, 'sudo'), `#!/bin/sh\necho "$*" >> ${calls}\n`, { mode: 0o755 })
  const path = process.env.PATH
  process.env.PATH = `${fakes}:${path}`
  isolate(WORKER)
  const clone = await workerRoot()
  try {
    await asWorker(clone, async () => {})
  } finally {
    isolate(undefined)
    process.env.PATH = path
    await rm(clone, { recursive: true, force: true })
  }
  const c = '[A-Za-z0-9]'.repeat(6)
  const [worker, root] = sudoersLines('dev')
  expect(worker).toBe('dev ALL=(awaywork) NOPASSWD:SETENV: ALL')
  const owner = `${process.getuid?.()}\\:${process.getgid?.()}`
  expect(root).toBe(
    `dev ALL=(root) NOPASSWD: /usr/bin/chown -R -h -P awaywork\\: /tmp/awaywork-${c}, /usr/bin/chown -R -h -P ${owner} /tmp/awaywork-${c}`,
  )
  // As sudoers matches these: `\:` is a colon, a class one character, the rest literal.
  const allowed = (root?.split('NOPASSWD: ')[1] ?? '').split(', ').map((command) => {
    const literal = command.replaceAll('\\:', ':').split('[A-Za-z0-9]')
    return new RegExp(
      `^${literal.map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('[A-Za-z0-9]')}$`,
    )
  })
  const chowns = (await readFile(calls, 'utf8'))
    .split('\n')
    .filter((call) => call.includes('chown'))
  expect(chowns).toHaveLength(2)
  for (const call of chowns)
    expect(allowed.some((rule) => rule.test(call.replace(/^-n /, '')))).toBe(true)
})
