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

  it("runs in the config file's folder once the config loads", async () => {
    const folder = await mkdtemp(join(tmpdir(), 'nightshift-'))
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
    const out = await mkdtemp(join(tmpdir(), 'nightshift-'))
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
