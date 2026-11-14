import type { EngineInterface, Register, RenderInput } from 'claude-code'
import { atom, read, update } from 'claude-code'

import type {
  Action,
  ConfigState,
  Data,
  Explained,
  Mark,
  Plan,
  Report,
  RuleTakes,
  Skills,
  Tab,
  View,
} from '../types'
import { awaywork, configPaths, firstLine, json, openInEditor, openUrl } from './cli'
import { draftNamed, mentionsConfig } from './config'
import { type Drawn, type Key, paneView } from './pane'
import { isPr, itemKey, layout, opens, pickOn, type Row, selected, startQuestion } from './rows'
import { folderOf } from './text'

const PANE = 'away'
const PLAN_TIMEOUT = 600_000

// The only file that touches state: the hook scanner rejects `read`/`update` on an imported atom.
const data = atom({ plugin: 'awaywork', key: 'data' } as const, {} as Data, { shape: 'data-2' })
const view = atom({ plugin: 'awaywork', key: 'view' } as const, {} as View, { shape: 'view-3' })
const config = atom({ plugin: 'awaywork', key: 'config' } as const, {} as ConfigState, {
  shape: 'config-1',
})

/** A call on the config setup named, which the shell profile can't bring to this session. */
async function onKnownConfig($: EngineInterface, args: string[]) {
  const { named } = await read($, config)
  return named ? ['--config', named, ...args] : args
}

type Slot = { running?: Promise<unknown>; again?: boolean }

/** Runs `work` one at a time; a call while it runs runs it once more after, so the last change is seen. */
function latest(slot: Slot, work: () => Promise<unknown>): Promise<unknown> {
  if (slot.running) {
    slot.again = true
    return slot.running
  }
  slot.running = work().finally(() => {
    slot.running = undefined
    if (slot.again) {
      slot.again = false
      void latest(slot, work)
    }
  })
  return slot.running
}

async function fetchTakes($: EngineInterface) {
  const c = await read($, config)
  if (!c.file || !c.view) return
  await update($, config, (x) => ({ ...x, takesError: undefined, readingTakes: true }))
  const got = await json<RuleTakes>($, ['--config', c.file, 'plan', '--rules', '--json'], 120_000)
  await update($, config, (x) => ({
    ...x,
    readingTakes: undefined,
    takes: 'json' in got ? got.json : x.takes,
    takesError: 'json' in got ? undefined : 'error' in got ? got.error : got.failed,
  }))
}

const takesSlot: Slot = {}
const syncSlot: Slot = {}

function readTakes($: EngineInterface) {
  return latest(takesSlot, () =>
    fetchTakes($).catch((e) =>
      update($, config, (x) => ({ ...x, readingTakes: undefined, takesError: String(e) })),
    ),
  )
}

/** Reads the draft, else the config, and what it says; an invalid file keeps the last good drawing. */
async function fetchConfig($: EngineInterface) {
  const c = await read($, config)
  const where = await configPaths($, c.named)
  if (!where.path || !where.draft) return
  const located = { path: where.path, draft: where.draft, setup: where.missing }
  const isDraft = await $.fs.exists(where.draft)
  const hasConfig = await $.fs.exists(where.path)
  const file = isDraft ? where.draft : where.path
  const text = isDraft || hasConfig ? await $.fs.read(file) : undefined
  // A file with problems is asked about again, so a failed explain doesn't outlive the file it failed on.
  if (text === c.text && !c.problems) {
    await update($, config, (x) => ({ ...x, ...located, file: text && file }))
    return
  }
  const got =
    text === undefined
      ? undefined
      : await json<Explained>($, ['--config', file, 'config', 'explain'])
  const said = got && 'json' in got ? got.json : undefined
  // A text explain gave no answer for isn't seen, so the next sync asks again.
  const seen = text === undefined || said !== undefined
  await update($, config, (x) => ({
    ...x,
    ...located,
    file: text === undefined ? undefined : file,
    text: seen ? text : x.text,
    previous: seen && text !== x.text ? x.text : x.previous,
    view: said?.valid ? said : text === undefined ? undefined : x.view,
    problems:
      said && !said.valid
        ? said.problems
        : got && !('json' in got)
          ? ['error' in got ? got.error : got.failed]
          : undefined,
    takes: text === undefined ? undefined : x.takes,
  }))
  if (said?.valid && (await read($, config)).wantTakes) void readTakes($)
}

function syncConfig($: EngineInterface) {
  return latest(syncSlot, () =>
    fetchConfig($).catch((e) => update($, config, (x) => ({ ...x, problems: [String(e)] }))),
  )
}

/** The rows' counts of what each rule takes now come in the background: `plan --rules` reads the sources. */
async function wantTakes($: EngineInterface) {
  await update($, config, (c) => ({ ...c, wantTakes: true }))
  await syncConfig($)
  void readTakes($)
}

/** Follows setup's draft once it's on disk: the CLI expands a `~/` and says whether the file is there. */
async function useDraft($: EngineInterface, named: string) {
  const { path, missing } = await configPaths($, named)
  if (path && !missing)
    await update($, config, (c) => ({ ...c, named: `${folderOf(path)}/config.yml` }))
}

async function readReport($: EngineInterface) {
  await update($, view, (v) => ({ ...v, status: undefined }))
  await update($, data, (d): Data => ({ ...d, loading: true }))
  const got = await json<Report>($, ['report', '--json'])
  const patch: Data =
    'json' in got
      ? { report: got.json }
      : 'failed' in got
        ? { noReport: got.failed }
        : { error: got.error }
  await update($, data, (d) => ({ plan: d.plan, planning: d.planning, ...patch }))
}

// plan probes quota and reads the forge, so it runs only when asked.
async function readPlan($: EngineInterface) {
  await update($, view, (v) => ({ ...v, status: undefined }))
  await update($, data, (d): Data => ({ ...d, planning: true }))
  const before = acts
  const got = await json<Plan>($, await onKnownConfig($, ['plan', '--json']), PLAN_TIMEOUT)
  const patch: Data =
    'json' in got ? { plan: got.json } : 'error' in got ? { error: got.error } : {}
  await update($, data, (d) => ({ ...d, planning: undefined, ...patch }))
  // A fresh plan shows what the marks said, unless an act came in while it was planning.
  if ('json' in got)
    await update($, view, (v) => ({ ...v, marks: acts === before ? undefined : v.marks }))
  if ('failed' in got) await update($, view, (v) => ({ ...v, status: `plan: ${got.failed}` }))
}

/** Work nobody awaits: whatever goes wrong ends on the error line, never on a "planning…" for good. */
const settled = ($: EngineInterface, work: Promise<void>, flag: 'loading' | 'planning') =>
  work.catch((e) => update($, data, (d) => ({ ...d, [flag]: undefined, error: String(e) })))

let reportCall: Promise<unknown> | undefined
let planCall: Promise<unknown> | undefined

const refresh = ($: EngineInterface) =>
  (reportCall ??= settled($, readReport($), 'loading').finally(() => {
    reportCall = undefined
  }))

const loadPlan = ($: EngineInterface) =>
  (planCall ??= settled($, readPlan($), 'planning').finally(() => {
    planCall = undefined
  }))

const questions = {
  skip: (ref: string) => `skip ${ref} in the coming runs? awaywork unskip undoes it`,
  unskip: (ref: string) => `unskip ${ref}? the coming runs can take it again`,
  approve: (ref: string) => `approve ${ref}? awaywork replies approve on it, no undo`,
}

const marked: Record<Action, Mark> = {
  skip: { skip: 'skipped' },
  unskip: { skip: 'unskipped' },
  approve: { approved: true },
  run: { started: true },
}

const declined: Record<Action, string> = {
  skip: 'not skipped',
  unskip: 'not unskipped',
  approve: 'not approved',
  run: 'not started',
}

let acts = 0

// The rows come from the last run's or plan's JSON, which an act doesn't change: a mark says what it did.
async function act($: EngineInterface, action: Action, key: string, skill?: string) {
  const starting = action === 'run'
  const status = starting ? 'starting… it plans first' : `${action}…`
  await update($, view, (v) => ({ ...v, confirm: undefined, status }))
  const picked = skill ? ['--skill', skill] : []
  const args = starting ? ['run', '--unit', key, ...picked, '--detach'] : [action, key]
  const r = await awaywork($, await onKnownConfig($, args), starting ? PLAN_TIMEOUT : undefined)
  if (r.exitCode === 0) acts++
  const said = firstLine(r.exitCode === 0 ? r.stdout : r.stderr) || `${action} exited ${r.exitCode}`
  await update($, view, (v) => ({
    ...v,
    status: said,
    marks:
      r.exitCode === 0 ? { ...v.marks, [key]: { ...v.marks?.[key], ...marked[action] } } : v.marks,
  }))
}

async function readRow($: EngineInterface, what: string[]) {
  await update($, view, (v) => ({ ...v, status: `awaywork ${what.join(' ')}…` }))
  const r = await awaywork($, what)
  const text = (r.stdout || r.stderr).trimEnd() || `exited ${r.exitCode}`
  await update($, view, (v) => ({
    ...v,
    status: undefined,
    reading: { title: `awaywork ${what.join(' ')}`, text },
    at: 0,
  }))
}

let skillsCall: Promise<unknown> | undefined

/** One load of the skills at a time: a second `g` while it reads does nothing. */
const pickSkill = ($: EngineInterface, row: Row, key: string) =>
  (skillsCall ??= loadPick($, row, key).finally(() => {
    skillsCall = undefined
  }))

/** Which skill for a card no rule takes: the CLI's list, `fix` on a PR, `implement` on anything else, first. */
async function loadPick($: EngineInterface, row: Row, key: string) {
  if ((await read($, view)).marks?.[key]?.started)
    return update($, view, (v) => ({ ...v, status: 'already started' }))
  await update($, view, (v) => ({ ...v, status: 'reading the skills…' }))
  const got = await json<Skills>($, await onKnownConfig($, ['skills', 'list', '--json']))
  if (!('json' in got))
    return update($, view, (v) => ({
      ...v,
      status: `skills: ${'failed' in got ? got.failed : got.error}`,
    }))
  const skills = got.json.skills.filter((s) => s.pickable)
  const wanted = row.url && isPr(row.url) ? 'fix' : 'implement'
  const first = skills.find((s) => s.name === wanted) ?? skills[0]
  if (!first) return update($, view, (v) => ({ ...v, status: 'no skill can be picked' }))
  const pick = {
    row: row.id,
    key,
    ref: row.ref,
    ...(row.theirs && { theirs: row.theirs }),
    skills: [first, ...skills.filter((s) => s !== first)].map(({ name, deliver }) => ({
      name,
      deliver,
    })),
  }
  await update($, view, (v) => ({ ...v, status: undefined, pick }))
}

async function showTab($: EngineInterface, tab: Tab) {
  await update($, view, (v) => ({
    ...v,
    tab,
    row: undefined,
    at: 0,
    status: undefined,
    pick: undefined,
    confirm: undefined,
  }))
  if (tab === 'config') await wantTakes($)
}

/** What `c` last put in the prompt box: the next press replaces it and keeps what you typed. */
let asked = ''

async function askClaude($: EngineInterface, text: string) {
  const { text: draft } = await $.prompt.read()
  const typed = draft.startsWith(asked) ? draft.slice(asked.length) : draft
  asked = text
  const { isFilled } = await $.prompt.fill({ text: text + typed })
  if (!isFilled)
    await update($, view, (v) => ({ ...v, status: "the prompt box can't take it now" }))
  return isFilled
}

/** The selected card's buttons: the confirm's yes and no, the skills to pick from, back from a report, or what the card can do. */
function cardButtons($: EngineInterface, v: View, row: Row): Key[] {
  const { confirm } = v
  const pick = pickOn(v, row)
  if (confirm)
    return [
      {
        key: 'yes',
        hotkey: 'y',
        label: 'yes',
        run: () => act($, confirm.action, confirm.key, confirm.skill),
      },
      {
        key: 'no',
        hotkey: 'n',
        label: 'no',
        run: () =>
          update($, view, (x) => ({
            ...x,
            confirm: undefined,
            status: declined[confirm.action],
          })),
      },
    ]
  if (pick)
    return [
      ...pick.skills.map(
        (s, i): Key => ({
          key: `pick:${s.name}`,
          hotkey: i === 0 ? 'g' : i <= 9 ? String(i) : undefined,
          label: s.name,
          run: () => {
            const question = `${startQuestion(pick.ref, s.name, s.deliver)}${pick.theirs && s.deliver !== 'report' ? " Merging it can close an issue that isn't assigned to you." : ''}`
            return update($, view, (x) => ({
              ...x,
              pick: undefined,
              confirm: { action: 'run' as Action, key: pick.key, skill: s.name, question },
            }))
          },
        }),
      ),
      {
        key: 'back',
        hotkey: 'b',
        label: 'back',
        run: () => update($, view, (x) => ({ ...x, pick: undefined })),
      },
    ]
  if (v.reading)
    return [
      {
        key: 'back',
        hotkey: 'b',
        label: 'back',
        run: () => update($, view, (x) => ({ ...x, reading: undefined, at: 0 })),
      },
    ]
  const { url, report, here, ref } = row
  const item = row.item && itemKey(row.item)
  const mark = item ? v.marks?.[item] : undefined
  const skip = mark?.skip ? (mark.skip === 'skipped' ? 'unskip' : 'skip') : row.skip
  const ask = (action: Action, question: string) => () =>
    item &&
    update($, view, (x) => {
      if (action === 'approve' && mark?.approved) return { ...x, status: 'already approved' }
      if (action === 'run' && mark?.started) return { ...x, status: 'already started' }
      return { ...x, confirm: { action, key: item, question } }
    })
  const keys: (Key | '' | undefined)[] = [
    row.approve &&
      item && {
        key: 'approve',
        hotkey: 'a',
        label: 'approve',
        run: ask('approve', questions.approve(ref)),
      },
    url && {
      key: 'open',
      hotkey: 'o',
      label: row.openAs ?? opens(url),
      run: () => openUrl($, url),
    },
    report && { key: 'report', hotkey: 'v', label: 'view report', run: () => readRow($, report) },
    skip && item && { key: 'skip', hotkey: 's', label: skip, run: ask(skip, questions[skip](ref)) },
    row.start && item && { key: 'run', hotkey: 'g', label: 'run now', run: ask('run', row.start) },
    row.picks &&
      item && { key: 'run', hotkey: 'g', label: 'run now', run: () => pickSkill($, row, item) },
    here && {
      key: 'here',
      hotkey: 'c',
      label: 'ask Claude',
      run: () => askClaude($, here),
    },
  ]
  return keys.filter((b): b is Key => !!b)
}

// The card shown already keeps its question or report: the strip names it with every key it posts.
async function select($: EngineInterface, id: string) {
  const d = await read($, data)
  await update($, view, (v) => (layout(d, v).row?.id === id ? v : selected(v, id)))
}

// In one update, so keys pressed in a row each step from where the last one left.
async function step($: EngineInterface, by: number) {
  const d = await read($, data)
  await update($, view, (v) => {
    const { list, row } = layout(d, v)
    const to = row && list[Math.min(list.length - 1, Math.max(0, list.indexOf(row) + by))]
    return to && to.id !== row.id ? selected(v, to.id) : v
  })
}

/** The last drawing's hotkeys, strip rows and detail end: `ui.scroll` and the strip's posts see no drawing. */
let drawn: Drawn = { press: {}, detailMax: 0 }

const scrollDetail = ($: EngineInterface, by: number) =>
  drawn.strip
    ? update($, view, (v) => ({
        ...v,
        at: Math.min(drawn.detailMax, Math.max(0, (v.at ?? 0) + by)),
      }))
    : $.ui.scroll({ to: by < 0 ? 'start' : 'end', in: PANE })

async function inFlow($: EngineInterface) {
  const v = await read($, view)
  const rules = (await read($, config)).view?.rules
  return v.tab === 'config' && (v.source ?? 'flow') === 'flow' && !!rules?.length
}

async function stepRule($: EngineInterface, by: number, reveal: boolean) {
  const rules = (await read($, config)).view?.rules ?? []
  let rule: number | undefined
  await update($, view, (v) => {
    const at = Math.max(
      0,
      rules.findIndex((r) => r.rule === v.rule),
    )
    rule = rules[Math.min(rules.length - 1, Math.max(0, at + Math.sign(by)))]?.rule
    return { ...v, rule }
  })
  // A reveal that fails must not undo the arrow's answer.
  if (reveal && rule !== undefined)
    await $.ui.scroll({ to: { key: `rule:${rule}` }, in: PANE }).catch(() => undefined)
}

async function render($: EngineInterface, e: RenderInput<'Pane'>) {
  const v = await read($, view)
  const out = paneView({
    e,
    els: $.ui.resolve(e),
    now: await $.clock.now(),
    d: await read($, data),
    v,
    c: await read($, config),
    keys: (row) => cardButtons($, v, row),
    on: {
      refresh: () => refresh($),
      plan: () => loadPlan($),
      takes: () => wantTakes($),
      tab: (tab) => showTab($, tab),
      step: (by) => step($, by),
      select: (id) => select($, id),
      fill: (text) => askClaude($, text),
      setView: (patch) => update($, view, (x) => ({ ...x, ...patch })),
      open: (file, line) => openInEditor($, file, line),
      stepRule: (by) => stepRule($, by, true),
    },
  })
  drawn = out.drawn
  return out.tree
}

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

  on('ui.render', { component: 'Pane', requestId: PANE }, render)
}
