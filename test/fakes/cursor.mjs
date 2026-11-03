#!/usr/bin/env node
// Stands in for Cursor's `agent` binary: replays a recorded print-mode run, leaving a worker-server behind as the real one does.
import { spawn } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { text } from 'node:stream/consumers'

const args = process.argv.slice(2)
const run = process.env.FAKE_CURSOR_RUN ?? 'exec'

if (args.includes('--version')) {
  console.log('2026.10.22-27dcf5f')
} else {
  const prompt = await text(process.stdin)
  if (process.env.FAKE_ARGV) writeFileSync(process.env.FAKE_ARGV, JSON.stringify(args))
  if (process.env.FAKE_ENV)
    writeFileSync(process.env.FAKE_ENV, JSON.stringify({ ...process.env, prompt }))
  const server = spawn('/bin/sleep', ['30'], { stdio: 'ignore' })
  if (process.env.FAKE_LEFT) writeFileSync(process.env.FAKE_LEFT, String(server.pid))
  server.unref()
  if (run === 'bad-key') {
    console.error('Error: The provided API key is invalid.')
    process.exitCode = 1
  } else {
    process.stdout.write(readFileSync(new URL(`../fixtures/cursor/${run}.jsonl`, import.meta.url)))
    if (process.env.FAKE_CURSOR_HANG) setTimeout(() => {}, 60_000)
  }
}
