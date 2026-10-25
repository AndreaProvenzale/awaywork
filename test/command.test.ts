import { copyFile, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { collectItems } from '../src/cli/plan.js'
import { loadConfig, parseConfig } from '../src/config/load.js'
import type { Ctx, Source } from '../src/core/types.js'
import { type CommandConfig, commandConfig, commandSource } from '../src/sources/command.js'
import { sourceContract } from './contracts/source.contract.js'

const dir = fileURLToPath(new URL('fixtures/command', import.meta.url))
const raw = { command: 'node items.mjs', fields: ['column'], secrets: ['TRACKER_TOKEN'] }
const cfg = (over: Partial<CommandConfig> = {}): CommandConfig => ({
  ...commandConfig.parse(raw),
  dir,
  ...over,
})
const ctx = (env: Ctx['env'] = {}): Ctx => ({ env: { ...process.env, ...env }, log: () => {} })

sourceContract(
  commandSource('tracker', cfg()) as Source<unknown>,
  { ...raw, command: `node ${join(dir, 'items.mjs')}` },
  process.env,
)

describe('command source', () => {
  const source = commandSource('tracker', cfg())

  it('kills its process group if awaywork exits first, and stops watching once done or failed', async () => {
    const before = process.listenerCount('exit')
    const pending = source.items(cfg(), ctx())
    expect(process.listenerCount('exit')).toBe(before + 1)
    await pending
    expect(process.listenerCount('exit')).toBe(before)
    await expect(source.items(cfg({ dir: join(dir, 'nope') }), ctx())).rejects.toThrow(/ENOENT/)
    expect(process.listenerCount('exit')).toBe(before)
  })

  it('turns the printed JSON into items with defaults', async () => {
    const [item] = await source.items(cfg(), ctx())
    expect(item).toMatchObject({
      source: 'tracker',
      key: 'AI-42',
      type: 'task',
      status: 'open',
      labels: [],
      linkedPrs: [],
      fields: { column: 'QA', repo: 'acme/api' },
    })
  })

  it('renders its link template on every item it collects', async () => {
    const item = {
      id: '7',
      key: 'AI 7',
      type: 'issue',
      title: 'Export',
      url: 'https://t.example/7',
    }
    const command = `echo '${JSON.stringify([item])}'`
    const tracker = { command, link: 'Refs {key} ({url}, #{id})' }
    const config = parseConfig(JSON.stringify({ providers: ['claude'], sources: { tracker } }))
    const [collected] = await collectItems(config, ctx())
    expect(collected?.link).toBe('Refs AI 7 (https://t.example/7, #7)')
  })

  it('tells the command how far back a rule reads finished items, only when one does', async () => {
    const closed = new Date(Date.now() - 3_600_000).toISOString()
    const items = [
      { id: '1', key: 'AI-1', title: 'Open', url: 'https://t.example/1' },
      { id: '2', key: 'AI-2', title: 'Done', url: 'https://t.example/2', state: 'closed', closed },
    ]
    // Prints the done item only when told the lookback.
    const script = `const all = ${JSON.stringify(items)}; console.log(JSON.stringify(process.env.AWAYWORK_CLOSED_SINCE ? all : all.slice(0, 1)))`
    const tracker = { command: `node -e '${script}'` }
    const config = (where: string) =>
      parseConfig(
        `providers: [claude]\nsources: { tracker: ${JSON.stringify(tracker)} }\nqueue: [{ skill: plan, source: tracker, where: ${where} }]`,
      )
    const open = await collectItems(config('{}'), ctx())
    expect(open.map((i) => [i.key, i.fields])).toEqual([['AI-1', { state: 'open' }]])
    const both = await collectItems(config('{ state: closed }'), ctx())
    expect(both.map((i) => [i.key, i.fields])).toEqual([
      ['AI-1', { state: 'open' }],
      ['AI-2', { state: 'closed', closed }],
    ])
  })

  it('keeps state and closed out of its declared fields', () => {
    expect(commandConfig.safeParse({ command: 'x', fields: ['state'] }).success).toBe(false)
    expect(commandConfig.safeParse({ command: 'x', fields: ['closed'] }).success).toBe(false)
  })

  it('warns about a crashing command in two capped lines: its first and its last error', async () => {
    const noise = `console.error('at frame\\n'.repeat(2000) + 'Error: ' + 'x'.repeat(500) + '\\n\\nNode.js v24.0.0\\n')`
    const tracker = { command: `node -e "${noise}; process.exit(1)"` }
    const config = parseConfig(JSON.stringify({ providers: ['claude'], sources: { tracker } }))
    const warnings: string[] = []
    await collectItems(config, { env: process.env, log: (line) => warnings.push(line) })
    const [first, last, ...rest] = (warnings[0] ?? '').split('\n')
    expect(first).toMatch(/^source tracker: Command failed with exit code 1: 'node -e/)
    expect(last).toBe(`Error: ${'x'.repeat(292)}…`)
    expect(rest).toEqual([])
  })

  it("runs in the config file's folder once the config loads", async () => {
    const folder = await mkdtemp(join(tmpdir(), 'awaywork-'))
    await copyFile(join(dir, 'items.mjs'), join(folder, 'items.mjs'))
    await writeFile(
      join(folder, 'config.yml'),
      'providers: [claude]\nsources: { tracker: { command: node items.mjs, fields: [column] } }\n',
    )
    const config = await loadConfig(join(folder, 'config.yml'))
    const [item] = await source.items(config.sources.tracker as CommandConfig, ctx())
    expect(item?.key).toBe('AI-42')
  })

  it('writes the context, or the description, and the comments for the worker', async () => {
    const out = await mkdtemp(join(tmpdir(), 'awaywork-'))
    const [plain] = await source.items(cfg(), ctx())
    if (plain) await source.prefetch(plain, out, ctx())
    const text = await readFile(join(out, 'item.md'), 'utf8')
    expect(text).toContain('# AI-42: Export invoices as CSV')
    expect(text).toContain('Users want a CSV export.')
    expect(text).toContain('### qa, 2026-01-02T10:00:00Z\n\nThe header row is missing.')

    const [rich] = await source.items(cfg(), ctx({ TRACKER_CONTEXT: 'Card with attachments' }))
    if (rich) await source.prefetch(rich, out, ctx())
    expect(await readFile(join(out, 'item.md'), 'utf8')).toContain('Card with attachments')
  })

  it('names what is wrong with the output', async () => {
    const run = (command: string, fields: string[] = ['column']) =>
      commandSource('tracker', cfg({ fields }))
        .items(cfg({ command, fields }), ctx())
        .then(
          () => '',
          (e: Error) => e.message,
        )
    expect(await run('echo nope')).toBe('`echo nope` did not print JSON')
    expect(await run(`echo '[{"id":"1","key":"A-1","url":"u"}]'`)).toBe(
      'items[0][title]: Invalid input: expected string, received undefined',
    )
    expect(await run('node items.mjs', [])).toBe(
      'AI-42: undeclared field "column"; add it to `fields`',
    )
    expect(await run('exit 3')).toMatch(/exit code 3/)
  })
})
