// Prints the CLI screens the docs show, colored, as JSON by name; `pnpm docs:gen` writes them.
// Each module in screens/ default-exports its page's screens; `--plain [module...]` previews them without colors.
import { readdirSync } from 'node:fs'
import { stripVTControlCharacters } from 'node:util'

const dir = new URL('screens/', import.meta.url)
const only = process.argv.slice(2).filter((a) => a !== '--plain')
const modules = readdirSync(dir)
  .filter((f) => f.endsWith('.ts') && (!only.length || only.includes(f.slice(0, -3))))
  .sort()
const screens: Record<string, string> = {}
for (const file of modules) {
  const page: Record<string, string> = (await import(new URL(file, dir).href)).default
  for (const [name, screen] of Object.entries(page)) {
    if (name in screens) throw new Error(`screens/${file}: "${name}" is already a screen`)
    screens[name] = screen
  }
}

if (process.argv.includes('--plain'))
  for (const [name, screen] of Object.entries(screens))
    console.log(`=== ${name}\n${stripVTControlCharacters(screen)}`)
else console.log(JSON.stringify(screens))
