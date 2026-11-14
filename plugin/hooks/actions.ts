import type { EngineInterface } from 'claude-code'
import { atom, read, update } from 'claude-code'

import type { Action, ConfigState, Data, Mark, Skills, Tab, View } from '../types'
import { awaywork, firstLine, json, PLAN_TIMEOUT } from './cli'
import { onKnownConfig, wantTakes } from './config'
import { itemKey, layout, type Row, startQuestion } from './rows'

export const PANE = 'away'

const data = atom({ plugin: 'awaywork', key: 'data' } as const, {} as Data, { shape: 'data-2' })
const view = atom({ plugin: 'awaywork', key: 'view' } as const, {} as View, { shape: 'view-3' })
const config = atom({ plugin: 'awaywork', key: 'config' } as const, {} as ConfigState, {
  shape: 'config-1',
})

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

export let acts = 0

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

let opener: string | undefined

export async function openInEditor($: EngineInterface, file: string, line: number) {
  const code = await $.process.run(['code', '-g', `${file}:${line}`]).catch(() => undefined)
  if (code?.exitCode !== 0) await openUrl($, file)
}

async function openUrl($: EngineInterface, url: string) {
  opener ??= (await $.process.run(['uname'])).stdout.trim() === 'Darwin' ? 'open' : 'xdg-open'
  await $.process.run([opener, url])
}

const isPr = (url: string) => /\/(pull|merge_requests|pull-requests)\//.test(url)

const opens = (url: string) =>
  isPr(url) ? 'open PR' : /\/issues\//.test(url) ? 'open issue' : 'open'

let skillsCall: Promise<unknown> | undefined

/** One load of the skills at a time: a second `g` while it reads does nothing. */
function pickSkill($: EngineInterface, row: Row, key: string) {
  skillsCall ??= loadPick($, row, key).finally(() => {
    skillsCall = undefined
  })
  return skillsCall
}

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

/** The picker `row` has up: a picker belongs to its card, which a load or a refresh may have moved off. */
export const pickOn = (v: View, row: Row | undefined) =>
  v.pick?.row === row?.id ? v.pick : undefined

export async function showTab($: EngineInterface, tab: Tab) {
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

type Key = { key: string; hotkey?: string; label: string; run: () => unknown }

/** What `c` last put in the prompt box: the next press replaces it and keeps what you typed. */
let asked = ''

export async function askClaude($: EngineInterface, text: string) {
  const { text: draft } = await $.prompt.read()
  const typed = draft.startsWith(asked) ? draft.slice(asked.length) : draft
  asked = text
  const { isFilled } = await $.prompt.fill({ text: text + typed })
  if (!isFilled)
    await update($, view, (v) => ({ ...v, status: "the prompt box can't take it now" }))
  return isFilled
}

/** The selected card's buttons: the confirm's yes and no, the skills to pick from, back from a report, or what the card can do. */
export function cardButtons($: EngineInterface, v: View, row: Row): Key[] {
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
          run: () =>
            update($, view, (x) => ({
              ...x,
              pick: undefined,
              confirm: {
                action: 'run',
                key: pick.key,
                skill: s.name,
                question: `${startQuestion(pick.ref, s.name, s.deliver)}${pick.theirs && s.deliver !== 'report' ? " Merging it can close an issue that isn't assigned to you." : ''}`,
              },
            })),
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

const selected = (v: View, id: string): View => ({
  ...v,
  row: id,
  at: 0,
  confirm: undefined,
  pick: undefined,
  reading: undefined,
  status: undefined,
})

// The card shown already keeps its question or report: the strip names it with every key it posts.
export async function select($: EngineInterface, id: string) {
  const d = await read($, data)
  await update($, view, (v) => (layout(d, v).row?.id === id ? v : selected(v, id)))
}

// In one update, so keys pressed in a row each step from where the last one left.
export async function step($: EngineInterface, by: number) {
  const d = await read($, data)
  await update($, view, (v) => {
    const { list, row } = layout(d, v)
    const to = row && list[Math.min(list.length - 1, Math.max(0, list.indexOf(row) + by))]
    return to && to.id !== row.id ? selected(v, to.id) : v
  })
}

/** No `strip` when the pane is too short for its regions: the engine scrolls it then. */
type Drawn = {
  press: Record<string, () => unknown>
  strip?: [number, number]
  detailMax: number
  /** The desktop app scrolls the pane itself: an arrow there is a smooth scroll, many events and none upward from the top. */
  nativeScroll?: boolean
}

/** The last drawing's hotkeys, strip rows and detail end: `ui.scroll` and the strip's posts see no drawing. */
export let drawn: Drawn = { press: {}, detailMax: 0 }

export function scrollDetail($: EngineInterface, by: number) {
  return drawn.strip
    ? update($, view, (v) => ({
        ...v,
        at: Math.min(drawn.detailMax, Math.max(0, (v.at ?? 0) + by)),
      }))
    : $.ui.scroll({ to: by < 0 ? 'start' : 'end', in: PANE })
}

export function setDrawn(d: Drawn) {
  drawn = d
}

export async function inFlow($: EngineInterface) {
  const v = await read($, view)
  const rules = (await read($, config)).view?.rules
  return v.tab === 'config' && (v.source ?? 'flow') === 'flow' && !!rules?.length
}

export async function stepRule($: EngineInterface, by: number, reveal: boolean) {
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
