#!/usr/bin/env node
// Stands in for the `codex` binary: replays a recorded exec run or answers the app server's rate-limit read.
import { readFileSync, writeFileSync } from 'node:fs'
import { createInterface } from 'node:readline'

const args = process.argv.slice(2)
const recorded = (name) =>
  readFileSync(new URL(`../fixtures/codex/${name}.jsonl`, import.meta.url), 'utf8')

if (args.includes('--version')) {
  console.log('codex-cli 0.149.1')
} else if (args[0] === 'app-server') {
  const [init, notice, limits] = recorded('rate-limits').trim().split('\n')
  for await (const line of createInterface({ input: process.stdin })) {
    const { id } = JSON.parse(line)
    if (id === 1) console.log(`${init}\n${notice}`)
    if (id === 2) console.log(limits)
  }
} else {
  if (process.env.FAKE_ARGV) writeFileSync(process.env.FAKE_ARGV, JSON.stringify(args))
  process.stdin.resume()
  process.stdout.write(recorded(process.env.FAKE_CODEX_RUN ?? 'exec'))
  if (process.env.FAKE_CODEX_HANG) setTimeout(() => {}, 60_000)
  else process.exitCode = process.env.FAKE_CODEX_RUN === 'failed' ? 1 : 0
}
