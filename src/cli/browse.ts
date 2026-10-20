import { spawn } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { emitKeypressEvents, type Key } from 'node:readline'
import { approveItem } from './approve.js'
import { skipItem } from './skip.js'
import { type Effect, resize, type State, settle, update, view } from './triage.js'

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

const enterScreen = '\u001b[?1049h\u001b[?25l'
const leaveScreen = '\u001b[?25h\u001b[?1049l'

/** Runs the triage view on the alternate screen until q, Esc or Ctrl-C, restoring the terminal on every way out. */
export function browse(start: State, commands: ItemCommands): Promise<void> {
  const { stdin, stdout } = process
  let state = resize(start, stdout.rows)
  let shown = false
  let paging = false
  let busy = false

  const draw = () => {
    const lines = view(state, stdout.columns, stdout.rows)
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

  const page = async (text: string): Promise<State> => {
    paging = true
    hide()
    const code = await new Promise<number | null>((done) => {
      const child = spawn(process.env.PAGER || 'less -R', {
        shell: true,
        stdio: ['pipe', 'inherit', 'inherit'],
      })
      // The pager may quit before it reads all of it.
      child.stdin.on('error', () => {})
      child.stdin.end(text)
      child.on('error', () => done(null))
      child.on('close', done)
    })
    paging = false
    show()
    return code ? { ...state, status: `the pager exited with ${code}` } : state
  }

  const perform = async (effect: Exclude<Effect, { action: 'quit' }>): Promise<State> => {
    switch (effect.action) {
      case 'read':
        return page(effect.target)
      case 'log':
      case 'diff':
        return page(await readFile(effect.target, 'utf8'))
      case 'open':
        await openUrl(effect.target)
        return { ...state, status: `opened ${effect.target}` }
      default:
        return commands[effect.action](effect.target).then(
          (message) => settle(state, effect, { ok: true, message }),
          (e: Error) => settle(state, effect, { ok: false, message: e.message }),
        )
    }
  }

  emitKeypressEvents(stdin)
  return new Promise<void>((resolve, reject) => {
    const finish = (error?: unknown) => {
      stdin.off('keypress', onKey)
      stdout.off('resize', onResize)
      process.off('SIGINT', onInt)
      process.off('SIGTERM', onTerm)
      process.off('exit', hide)
      hide()
      if (error) reject(error)
      else resolve()
    }
    const press = async (key: string) => {
      const { state: next, effect } = update(state, key)
      state = next
      if (effect?.action === 'quit') return finish()
      draw()
      if (!effect) return
      state = await perform(effect).catch((e: Error) => ({ ...state, status: e.message }))
      draw()
    }
    const onKey = (text: string | undefined, key: Key | undefined) => {
      if (busy) return
      busy = true
      press(keyName(text, key)).then(() => {
        busy = false
      }, finish)
    }
    const onResize = () => {
      state = resize(state, stdout.rows)
      if (!paging) draw()
    }
    // Outside raw mode, as while paging, Ctrl-C is a signal: it's the pager's to handle.
    const onInt = () => {
      if (!paging) finish()
    }
    const onTerm = () => {
      hide()
      process.exit(143)
    }
    stdin.on('keypress', onKey)
    stdout.on('resize', onResize)
    process.on('SIGINT', onInt)
    process.on('SIGTERM', onTerm)
    process.on('exit', hide)
    try {
      show()
    } catch (e) {
      finish(e)
    }
  })
}

function keyName(text: string | undefined, key: Key | undefined): string {
  if (key?.ctrl && key.name === 'c') return 'ctrl-c'
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
