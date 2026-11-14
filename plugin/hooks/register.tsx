import type { EngineInterface, Register } from 'claude-code'
import { atom, read, update } from 'claude-code'

import type { ConfigState, Data, View } from '../types'
import { cardButtons, drawn, inFlow, PANE, scrollDetail, select, step, stepRule } from './actions'
import { configPaths, draftNamed, mentionsConfig, syncConfig, useDraft, wantTakes } from './config'
import { planCall, refresh } from './load'
import { pane } from './pane'
import { layout } from './rows'

const data = atom({ plugin: 'awaywork', key: 'data' } as const, {} as Data, { shape: 'data-2' })
const view = atom({ plugin: 'awaywork', key: 'view' } as const, {} as View, { shape: 'view-3' })
const config = atom({ plugin: 'awaywork', key: 'config' } as const, {} as ConfigState, {
  shape: 'config-1',
})

const paneOpen = async ($: EngineInterface) => (await $.ui.panes()).some((p) => p.id === PANE)

export const register: Register = (on) => {
  on('command.run', { command: ['away', 'awaywork:away'] }, async ($, e, next) => {
    // A request goes to the skill, and so does a run nobody typed with no surface to draw on (`-p`).
    // The desktop app attaches only once the pane asks to draw, so a typed /away opens it anyway.
    const headless = e.origin.kind !== 'composer' && (await $.session.surfaces()).length === 0
    if (headless) return next(e)
    // A config a setup moved into a control folder counts, before the shell profile names it.
    const where = await configPaths($, (await read($, config)).named)
    if (where.missing) {
      await update($, view, (v): View => ({ marks: v.marks, tab: 'config' }))
      await $.ui.open({ id: PANE, title: 'awaywork' })
      void wantTakes($)
      return next(e)
    }
    if (e.args.trim()) return next(e)
    const drafting = !!where.draft && (await $.fs.exists(where.draft))
    await update($, view, (v): View => ({ marks: v.marks, tab: drafting ? 'config' : undefined }))
    await update($, data, (d): Data => ({ ...d, loading: true, planning: planCall && true }))
    await $.ui.open({ id: PANE, title: 'awaywork', focus: true, closeOnEscape: true })
    void refresh($)
    void (drafting ? wantTakes($) : syncConfig($))
    return {}
  })

  // Watchers start only here. The folder, so a first setup's files show up too; it must exist.
  // A path `config path` answers for that isn't here is a remote's, with nothing to watch.
  on('classic.SessionStart', async ($, e, next) => {
    const r = await next(e)
    const { missing, path } = await configPaths($, undefined, 2_000)
    if (!path || (!missing && !(await $.fs.exists(path)))) return r
    const folder = path.slice(0, path.lastIndexOf('/'))
    if (missing) await $.process.run(['mkdir', '-p', folder])
    return { ...r, watchPaths: [...(r.watchPaths ?? []), folder] }
  })

  on('classic.FileChanged', async ($, e, next) => {
    if (/\/config(\.draft)?\.yml$/.test(e.file_path) && (await paneOpen($))) void syncConfig($)
    return next(e)
  })

  // The agent's writes where no watcher looks yet: a draft in a control folder picked during setup.
  on('tool.call', async ($, e, next) => {
    const r = await next(e)
    const isFile = e.tool === 'Write' || e.tool === 'Edit'
    const text = isFile ? e.file_path : e.tool === 'Bash' ? e.command : ''
    if (!text) return r
    const c = await read($, config)
    if (!mentionsConfig(text, c) || !(await paneOpen($))) return r
    const named = c.setup ? draftNamed(isFile, text) : undefined
    if (named) await useDraft($, named)
    void syncConfig($)
    return r
  })

  // A body that fits its window: the wheel over the strip steps the cards, anything else scrolls the detail.
  on('ui.scroll', { requestId: PANE }, async ($, e, next) => {
    if (e.origin.kind === 'person' && !drawn.nativeScroll && (await inFlow($))) {
      // Past the rows `done` keeps spare, the body doesn't fit: the wheel and page keys scroll it.
      const overflows = e.contentRows > e.bodyRows + 1
      const arrow = !e.pointer && Math.abs(e.by) === 1
      if (overflows && !arrow) return next(e)
      if (arrow || e.pointer) await stepRule($, e.by, overflows)
      // A body that fits stays at its top: a reveal left scrolled would hide the header.
      return overflows ? { deny: 'the arrows move between rules' } : next({ ...e, offset: 0 })
    }
    if (!drawn.strip) return next(e)
    const r = e.pointer?.row
    const [top, bottom] = drawn.strip
    if (r !== undefined && r >= top && r <= bottom) await step($, Math.sign(e.by))
    else await scrollDetail($, e.by)
    return { deny: 'awaywork scrolls its own regions' }
  })

  on('ui.message', { element: 'cards' }, async ($, e) => {
    const m = e.data as { select?: string; key?: string }
    if (m.select) await select($, m.select)
    if (m.key === 'up' || m.key === 'down') await scrollDetail($, m.key === 'up' ? -1 : 1)
    else if (m.key === 'pageup' || m.key === 'pagedown')
      await scrollDetail($, m.key === 'pageup' ? -5 : 5)
    else if (m.key) {
      // The card's own keys as it is now: the select above may not be drawn yet.
      const d = await read($, data)
      const v = await read($, view)
      const { row } = layout(d, v)
      const own = row && cardButtons($, v, row).find((b) => b.hotkey === m.key)
      const ran = await (own ? own.run() : drawn.press[m.key]?.())
      // Keys a click gave the strip stay there, and only Esc takes them back.
      if (own?.key === 'here' && ran)
        await update($, view, (x) => ({ ...x, status: 'in the prompt box: Esc, then type' }))
    }
    return {}
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, pane)
}
