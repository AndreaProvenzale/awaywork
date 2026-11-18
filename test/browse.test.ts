import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { stripVTControlCharacters } from 'node:util'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { type ItemCommands, openScreen } from '#cli/tui/browse'
import type { State } from '#cli/tui/triage'

const start: State = {
  header: ['Run 20261019-220000'],
  sections: [
    {
      id: 'units',
      text: 'Units',
      children: [
        { id: 'unit', text: 'unit 1', act: { unit: '1', log: '1', skip: 'github:acme/api#1' } },
      ],
    },
  ],
  actions: ['read', 'log', 'skip'],
  open: new Set(['units']),
  selected: 'unit',
  top: 0,
  rows: 20,
  marks: {},
}

/** Commands on a box that never answers, each call noted with the signal it got. */
function hanging() {
  const calls: { call: string; stop?: AbortSignal }[] = []
  const wait = (call: string) => (target: string, stop?: AbortSignal) => {
    calls.push({ call: `${call} ${target}`, stop })
    return new Promise<string>((_, fail) =>
      stop?.addEventListener('abort', () => fail(new Error('aborted'))),
    )
  }
  const commands: ItemCommands = {
    remote: 'http://box',
    skip: wait('skip'),
    approve: wait('approve'),
    unit: wait('unit'),
    log: wait('log'),
    diff: wait('diff'),
  }
  return { calls, commands }
}

describe('the screen while a remote call waits', () => {
  let frame = ''
  const status = () => stripVTControlCharacters(frame.split('\r\n').at(-1) ?? '')
  // A key, once the one before it is done with or waiting.
  const press = async (name: string, key: object = { name }) => {
    await new Promise(setImmediate)
    process.stdin.emit('keypress', name, key)
  }
  const { stdin, stdout } = process
  const tty = {
    setRawMode: stdin.setRawMode,
    hasColors: stdout.hasColors,
    columns: stdout.columns,
    rows: stdout.rows,
  }

  beforeEach(() => {
    Object.assign(stdin, { setRawMode: vi.fn() })
    Object.assign(stdout, { hasColors: () => false, columns: 80, rows: 20 })
    vi.spyOn(stdin, 'resume').mockReturnValue(stdin)
    vi.spyOn(stdin, 'pause').mockReturnValue(stdin)
    vi.spyOn(stdout, 'write').mockImplementation((s) => {
      frame = String(s)
      return true
    })
  })
  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllEnvs()
    Object.assign(stdin, { setRawMode: tty.setRawMode })
    Object.assign(stdout, { hasColors: tty.hasColors, columns: tty.columns, rows: tty.rows })
  })

  it('says what it waits on, takes no other key, and q cancels it back to the view; the next q quits', async () => {
    const { calls, commands } = hanging()
    const browsed = openScreen('Loading the report').browse(start, commands)
    await press('l')
    expect(status()).toBe('fetching from http://box…')
    await press('l')
    await press('s')
    expect(calls.map((c) => c.call)).toEqual(['log 1'])
    await press('q')
    await vi.waitFor(() => expect(status()).toBe('cancelled'))
    expect(calls[0]?.stop?.aborted).toBe(true)
    await press('q')
    await browsed
  })

  it("fetches a unit's text on ⏎ as l does, and q cancels it", async () => {
    const { calls, commands } = hanging()
    const browsed = openScreen('Loading the report').browse(start, commands)
    await press('return')
    expect(status()).toBe('fetching from http://box…')
    await press('q')
    await vi.waitFor(() => expect(status()).toBe('cancelled'))
    expect(calls.map((c) => c.call)).toEqual(['unit 1'])
    expect(calls[0]?.stop?.aborted).toBe(true)
    await press('q')
    await browsed
  })

  it("pages the unit's text the box sent on ⏎", async () => {
    const paged = join(await mkdtemp(join(tmpdir(), 'pager-')), 'paged')
    vi.stubEnv('PAGER', `cat > ${paged}`)
    const unit = vi.fn(async () => 'unit 1 in full')
    const browsed = openScreen('Loading the report').browse(start, { ...hanging().commands, unit })
    await press('return')
    await vi.waitFor(async () => expect(await readFile(paged, 'utf8')).toBe('unit 1 in full'))
    expect(unit).toHaveBeenCalledWith('1', expect.any(AbortSignal))
    await press('q')
    await browsed
  })

  it('says a cancelled skip may still have applied on the box, and marks nothing', async () => {
    const { calls, commands } = hanging()
    const browsed = openScreen('Planning the next run').browse(start, commands)
    await press('s')
    await press('y')
    expect(status()).toBe('skipping on http://box…')
    await press('\u0003', { name: 'c', ctrl: true })
    await vi.waitFor(() =>
      expect(status()).toBe(
        'cancelled; http://box may still have skipped it, and skipping again is safe',
      ),
    )
    expect(calls.map((c) => c.call)).toEqual(['skip github:acme/api#1'])
    expect(frame.split('\r\n').find((l) => l.includes('unit 1'))).not.toContain('skipped')
    await press('escape')
    await browsed
  })

  it('aborts the waiting call when the screen closes, and draws nothing after', async () => {
    const { calls, commands } = hanging()
    const screen = openScreen('Loading the report')
    void screen.browse(start, commands)
    await press('l')
    screen.close()
    expect(calls[0]?.stop?.aborted).toBe(true)
    await new Promise(setImmediate)
    expect(frame).toBe('\u001b[?25h\u001b[?1049l')
  })

  it('keeps a resize made while waiting', async () => {
    const { commands } = hanging()
    const units = Array.from({ length: 30 }, (_, i) => ({
      id: `u${i + 1}`,
      text: `unit ${i + 1}`,
      act: { log: `${i + 1}` },
    }))
    const tall = {
      ...start,
      sections: [{ id: 'units', text: 'Units', children: units }],
      selected: 'u1',
    }
    const browsed = openScreen('Loading the report').browse(tall, commands)
    await press('l')
    Object.assign(stdout, { rows: 10 })
    stdout.emit('resize')
    await press('q')
    await vi.waitFor(() => expect(status()).toBe('cancelled'))
    for (let i = 0; i < 15; i++) await press('j')
    await vi.waitFor(() => expect(frame).toContain('unit 16'))
    await press('q')
    await browsed
  })
})
