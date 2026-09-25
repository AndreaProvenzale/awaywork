#!/usr/bin/env node
// Stands in for the `claude` binary: replays a recorded stream-json run, then idles if FAKE_CLAUDE_HANG is set.
import { readFileSync } from 'node:fs'

const args = process.argv.slice(2)
if (args.includes('--version')) {
  console.log('2.1.282 (Claude Code)')
} else {
  const name = args.includes('claude-haiku-4-5-20251001') ? 'probe' : 'max-turns'
  process.stdout.write(readFileSync(new URL(`../fixtures/claude/${name}.jsonl`, import.meta.url)))
  if (process.env.FAKE_CLAUDE_HANG) setTimeout(() => {}, 60_000)
}
