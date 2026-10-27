import { copyFile, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { collectItems } from '../src/cli/plan.js'
import { loadConfig, parseConfig } from '../src/config/load.js'
import type { Ctx, Source } from '../src/core/types.js'
import { type CommandConfig, commandConfig, commandSource } from '../src/sources/command.js'
import { configSecrets, workerEnv } from '../src/worker/workspace.js'
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

  it('ignores a state or closed it cannot read, as commands printed them before, saying so once', async () => {
    const items = [
      { id: '1', key: 'GL-1', title: 'Open', url: 'https://t.example/1', state: 'opened' },
      { id: '2', key: 'GL-2', title: 'Done', url: 'https://t.example/2', closed: true },
    ]
    const lines: string[] = []
    const tracker = commandSource('tracker', cfg())
    const found = await tracker.items(cfg({ command: `echo '${JSON.stringify(items)}'` }), {
      env: process.env,
      log: (line) => lines.push(line),
    })
    expect(found.map((i) => [i.key, i.fields])).toEqual([
      ['GL-1', { state: 'open' }],
      ['GL-2', { state: 'open' }],
    ])
    expect(lines).toEqual([
      `tracker: ignoring GL-1's state "opened", and any like it: a top-level state is open or closed, and closed a datetime`,
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

  it('writes nothing without a `write` command', () => {
    expect(source.write).toBeUndefined()
  })

  it('pipes a write as JSON to its `write` command, in the config folder with its env', async () => {
    const out = join(await mkdtemp(join(tmpdir(), 'awaywork-')), 'write.json')
    const write =
      'cat > "$OUT"; pwd >> "$OUT.pwd"; echo "$TRACKER_TOKEN" >> "$OUT.pwd"; echo \'{"before":"2026-01-03T08:00:00Z","after":"2026-01-04T08:00:00Z"}\''
    const c = cfg({ write })
    const writer = commandSource('tracker', c)
    const [item] = await writer.items(c, ctx())
    const env = ctx({ OUT: out, TRACKER_TOKEN: 'tok' })
    const moved = await writer.write?.(c, item as never, { op: 'move', to: 'QA' }, env)
    expect(moved).toEqual({ before: '2026-01-03T08:00:00Z', after: '2026-01-04T08:00:00Z' })
    expect(JSON.parse(await readFile(out, 'utf8'))).toEqual({
      op: 'move',
      item: 'AI-42',
      id: item?.id,
      to: 'QA',
    })
    expect(await readFile(`${out}.pwd`, 'utf8')).toBe(`${dir}\ntok\n`)
    await writer.write?.(c, item as never, { op: 'comment', body: 'Which?' }, env)
    expect(JSON.parse(await readFile(out, 'utf8'))).toMatchObject({ op: 'comment', body: 'Which?' })
  })

  it('fails a write whose command fails, and returns no times it did not print', async () => {
    const failing = cfg({ write: 'echo denied >&2; exit 2' })
    const item = { id: '1', key: 'AI-1' } as never
    await expect(
      commandSource('tracker', failing).write?.(failing, item, { op: 'move', to: 'QA' }, ctx()),
    ).rejects.toThrow(/denied/)
    for (const printed of ['moved', '{"after":"yesterday"}']) {
      const quiet = cfg({ write: `cat > /dev/null; echo '${printed}'` })
      expect(
        await commandSource('tracker', quiet).write?.(quiet, item, { op: 'move', to: 'QA' }, ctx()),
      ).toEqual({})
    }
  })

  it("keeps the write command's secrets, besides the read command's, from workers", () => {
    const config = parseConfig(`
providers: [claude]
sources:
  tracker: { command: 'node items.mjs', write: 'node write.mjs', secrets: [TRACKER_READ, TRACKER_WRITE] }
`)
    const tracker = commandSource('tracker', config.sources.tracker as CommandConfig)
    const secrets = configSecrets(config, {}, { tracker })
    const env = { PATH: '/bin', TRACKER_READ: 'r', TRACKER_WRITE: 'w' }
    expect(Object.keys(workerEnv(env, '/tmp/clone', secrets))).not.toContain('TRACKER_WRITE')
    expect(Object.keys(workerEnv(env, '/tmp/clone', secrets))).not.toContain('TRACKER_READ')
  })

  it('takes which comments your own account wrote, and makes every item yours', async () => {
    const json = JSON.stringify([
      {
        id: '1',
        key: 'A-1',
        title: 't',
        url: 'u',
        comments: [
          { author: 'me', body: 'x', at: 't', mine: true },
          { author: 'qa', body: 'y', at: 't', mine: false },
        ],
      },
    ])
    const [item] = await source.items(cfg({ command: `echo '${json}'` }), ctx())
    expect(item?.comments).toEqual([
      { author: 'me', body: 'x', at: 't', mine: true },
      { author: 'qa', body: 'y', at: 't' },
    ])
    expect(item?.mine).toBe(true)
  })

  it("shows awaywork's questions in item.md, then the reply", async () => {
    const comments = [
      { author: 'me', body: 'Per user?\n\n— awaywork', at: 't1', mine: true },
      { author: 'qa', body: 'Per key.', at: 't2' },
    ]
    const json = JSON.stringify([{ id: '1', key: 'A-1', title: 't', url: 'u', comments }])
    const c = cfg({ command: `printf '%s' '${json}'` })
    const [item] = await source.items(c, ctx())
    const out = await mkdtemp(join(tmpdir(), 'awaywork-'))
    if (item) await source.prefetch(item, out, ctx())
    expect(await readFile(join(out, 'item.md'), 'utf8')).toContain(
      "### awaywork's questions (me), t1\n\nPer user?\n\n— awaywork\n\n### qa, t2\n\nPer key.",
    )
  })
})
