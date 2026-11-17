import { type ChildProcess, spawn } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { emitKeypressEvents, type Key } from 'node:readline'
import { approveItem } from '#cli/commands/approve'
import { skipItem } from '#cli/commands/skip'
import type { Config } from '#config/schema'
import type { OnProgress } from '#plan/probe'
import { terminalBrand } from './ask'
import {
  type Effect,
  loading,
  loadingView,
  progress,
  ready,
  resize,
  type State,
  settle,
  tick,
  update,
  view,
} from './triage'

/** A person at a terminal: stdin and stdout are TTYs and `CI` is unset. */
export const interactive = () => !!process.stdin.isTTY && !!process.stdout.isTTY && !process.env.CI

/** What `s` and `a` run, `awaywork skip` and `awaywork approve`, each resolving to its message; and the texts `l` and `d` page. */
export interface ItemCommands {
  /** Where they run when not here: awaited with a status, and q, Esc or Ctrl-C abort `stop`. */
  remote?: string
  skip(key: string, stop?: AbortSignal): Promise<string>
  approve(key: string, stop?: AbortSignal): Promise<string>
  log(target: string, stop?: AbortSignal): Promise<string>
  diff(target: string, stop?: AbortSignal): Promise<string>
}

export const itemCommands = (config: () => Promise<Config>): ItemCommands => ({
  skip: async (key) => skipItem(key, {}, Object.keys((await config()).sources)),
  approve: async (key) => approveItem(key, await config(), '', { ctx: quiet }),
  log: (file) => readFile(file, 'utf8'),
  diff: (file) => readFile(file, 'utf8'),
})

// A source's warnings would print over the screen.
const quiet = { env: process.env, log: () => {} }

/** `$PAGER` unless it's unset or `cat`, as git does; the default `less` repaints from the top and stays open on short texts whatever `$LESS` says. */
export const pagerCommand = (pager = process.env.PAGER) =>
  pager && pager !== 'cat' ? pager : 'less -R -c -+F -+X'

const waitingOn = {
  log: 'fetching from',
  diff: 'fetching from',
  skip: 'skipping on',
  approve: 'approving on',
}
const quits = ['q', 'escape', 'ctrl-c']

function cancelled(action: keyof typeof waitingOn, remote?: string) {
  if (action === 'log' || action === 'diff') return 'cancelled'
  const [done, doing] = action === 'skip' ? ['skipped', 'skipping'] : ['approved', 'approving']
  return `cancelled; ${remote} may still have ${done} it, and ${doing} again is safe`
}

const enterScreen = '\u001b[?1049h\u001b[?25l'
const leaveScreen = '\u001b[?25h\u001b[?1049l'

/** The alternate screen, open while loading: a loader until `browse` makes it the triage view. */
export interface Screen {
  progress: OnProgress
  /** Shows the view until q, Esc or Ctrl-C, then leaves the screen. */
  browse(start: State, commands: ItemCommands): Promise<void>
  /** Leaves the screen, as before printing a fatal error; again does nothing. */
  close(): void
}

/** Enters the screen at once with a loader; q, Esc or Ctrl-C while loading leave and exit. */
export function openScreen(title: string): Screen {
  const { stdin, stdout } = process
  let loader = loading(terminalBrand(), title)
  let state: State | undefined
  let commands: ItemCommands | undefined
  let shown = false
  let pager: ChildProcess | undefined
  let busy = false
  let waiting: AbortController | undefined
  let finish: (error?: unknown) => void = close

  const draw = () => {
    const lines = state
      ? view(state, stdout.columns, stdout.rows)
      : loadingView(loader, stdout.columns, stdout.rows)
    stdout.write(`\u001b[H${lines.join('\u001b[K\r\n')}\u001b[K\u001b[J`)
  }
  const show = () => {
    shown = true
    stdout.write(enterScreen)
    stdin.setRawMode(true)
    stdin.resume()
    draw()
  }
  const hide = () => {
    if (!shown) return
    shown = false
    stdin.setRawMode(false)
    stdin.pause()
    stdout.write(leaveScreen)
  }
  const spin = setInterval(() => {
    loader = tick(loader)
    draw()
  }, 80)

  const page = async (now: State, text: string): Promise<State> => {
    state = now
    hide()
    const code = await new Promise<number | null>((done) => {
      const child = spawn(pagerCommand(), { shell: true, stdio: ['pipe', 'inherit', 'inherit'] })
      pager = child
      // The pager may quit before it reads all of it.
      child.stdin.on('error', () => {})
      child.stdin.end(text)
      child.on('error', () => done(null))
      child.on('close', done)
    })
    pager = undefined
    show()
    return code ? { ...now, status: `the pager exited with ${code}` } : now
  }

  const perform = async (
    now: State,
    effect: Exclude<Effect, { action: 'quit' }>,
  ): Promise<State> => {
    switch (effect.action) {
      case 'read':
        return page(now, effect.target)
      case 'open':
        await openUrl(effect.target)
        return { ...now, status: `opened ${effect.target}` }
    }
    if (!commands) return now
    const { action, target } = effect
    const { remote } = commands
    if (remote) {
      state = { ...now, status: `${waitingOn[action]} ${remote}…` }
      draw()
      waiting = new AbortController()
    }
    const stop = waiting?.signal
    const outcome = await commands[action](target, stop).then(
      (message) => ({ ok: true, message }),
      (e: Error) => ({ ok: false, message: e.message }),
    )
    waiting = undefined
    if (stop?.aborted) return { ...now, status: cancelled(action, remote) }
    if (action === 'skip' || action === 'approve') return settle(now, effect, outcome)
    return outcome.ok ? page(now, outcome.message) : { ...now, status: outcome.message }
  }

  const quitLoading = () => {
    close()
    process.exit(0)
  }
  const press = async (key: string) => {
    if (!state) {
      if (quits.includes(key)) quitLoading()
      return
    }
    const { state: next, effect } = update(state, key)
    state = next
    if (effect?.action === 'quit') return finish()
    draw()
    if (!effect) return
    const now = state
    const done = await perform(now, effect).catch((e: Error) => ({ ...now, status: e.message }))
    state = resize(done, stdout.rows)
    if (shown) draw()
  }
  const onKey = (text: string | undefined, key: Key | undefined) => {
    if (busy) {
      if (quits.includes(keyName(text, key))) waiting?.abort()
      return
    }
    busy = true
    press(keyName(text, key)).then(
      () => {
        busy = false
      },
      (e: unknown) => finish(e),
    )
  }
  const onResize = () => {
    if (state) state = resize(state, stdout.rows)
    if (!pager) draw()
  }
  // Outside raw mode, as while paging, Ctrl-C is a signal: it's the pager's to handle.
  const onInt = () => {
    if (!pager) state ? finish() : quitLoading()
  }
  const onTerm = () => {
    pager?.kill()
    hide()
    process.exit(143)
  }
  function close() {
    waiting?.abort()
    clearInterval(spin)
    stdin.off('keypress', onKey)
    stdout.off('resize', onResize)
    process.off('SIGINT', onInt)
    process.off('SIGTERM', onTerm)
    process.off('exit', hide)
    hide()
  }

  emitKeypressEvents(stdin)
  stdin.on('keypress', onKey)
  stdout.on('resize', onResize)
  process.on('SIGINT', onInt)
  process.on('SIGTERM', onTerm)
  process.on('exit', hide)
  try {
    show()
  } catch (e) {
    close()
    throw e
  }

  return {
    progress(step) {
      loader = progress(loader, step)
      if (!state && shown) draw()
    },
    browse(start, given) {
      clearInterval(spin)
      commands = given
      state = resize(ready(loader, start), stdout.rows)
      draw()
      return new Promise<void>((resolve, reject) => {
        finish = (error) => {
          close()
          if (error) reject(error)
          else resolve()
        }
      })
    },
    close,
  }
}

function keyName(text: string | undefined, key: Key | undefined): string {
  if (key?.ctrl && key.name?.length === 1) return `ctrl-${key.name}`
  if (key?.name === 'enter') return 'return'
  if (key?.name && key.name.length > 1) return key.name
  return text ?? ''
}

function openUrl(url: string): Promise<void> {
  const child = spawn(process.platform === 'darwin' ? 'open' : 'xdg-open', [url], {
    stdio: 'ignore',
    detached: true,
  })
  child.unref()
  return new Promise((ok, fail) => {
    child.once('spawn', ok)
    child.once('error', fail)
  })
}
