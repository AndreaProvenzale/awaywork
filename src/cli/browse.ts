import { type ChildProcess, spawn } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { emitKeypressEvents, type Key } from 'node:readline'
import { approveItem } from './approve.js'
import { terminalBrand } from './ask.js'
import { skipItem } from './skip.js'
import {
  type Effect,
  loading,
  loadingView,
  type OnProgress,
  progress,
  ready,
  resize,
  type State,
  settle,
  tick,
  update,
  view,
} from './triage.js'

/** A person at a terminal: stdin and stdout are TTYs and `CI` is unset. */
export const interactive = () => !!process.stdin.isTTY && !!process.stdout.isTTY && !process.env.CI

/** What `s` and `a` run: `awaywork skip` and `awaywork approve`, each resolving to its message. */
export interface ItemCommands {
  skip(key: string): Promise<string>
  approve(key: string): Promise<string>
}

export const itemCommands = (sources: () => Promise<string[]>): ItemCommands => ({
  skip: async (key) => skipItem(key, {}, await sources()),
  approve: async (key) => approveItem(key, await sources()),
})

/** `$PAGER` unless it's unset or `cat`, as git does; the default `less` repaints from the top and stays open on short texts whatever `$LESS` says. */
export const pagerCommand = (pager = process.env.PAGER) =>
  pager && pager !== 'cat' ? pager : 'less -R -c -+F -+X'

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
      case 'log':
      case 'diff':
        return page(now, await readFile(effect.target, 'utf8'))
      case 'open':
        await openUrl(effect.target)
        return { ...now, status: `opened ${effect.target}` }
      default:
        if (!commands) return now
        return commands[effect.action](effect.target).then(
          (message) => settle(now, effect, { ok: true, message }),
          (e: Error) => settle(now, effect, { ok: false, message: e.message }),
        )
    }
  }

  const quitLoading = () => {
    close()
    process.exit(0)
  }
  const press = async (key: string) => {
    if (!state) {
      if (key === 'q' || key === 'escape' || key === 'ctrl-c') quitLoading()
      return
    }
    const { state: next, effect } = update(state, key)
    state = next
    if (effect?.action === 'quit') return finish()
    draw()
    if (!effect) return
    const now = state
    state = await perform(now, effect).catch((e: Error) => ({ ...now, status: e.message }))
    draw()
  }
  const onKey = (text: string | undefined, key: Key | undefined) => {
    if (busy) return
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
