// Stands in for a repo's dev server: SERVE_MODE is ready (the default), never or exit; SERVE_PIDS gets the pid of a detached child.
import { spawn } from 'node:child_process'
import { appendFileSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'

const { SERVE_MODE = 'ready', SERVE_PIDS, SERVE_STARTED, AWAYWORK_PORT } = process.env
if (SERVE_STARTED) writeFileSync(SERVE_STARTED, 'started')
console.log(`booting in ${SERVE_MODE} mode`)
if (SERVE_MODE === 'exit') {
  console.error('boom: no database')
  process.exit(1)
}
if (SERVE_PIDS) {
  const child = spawn('sleep', ['300'], { detached: true, stdio: 'ignore' })
  child.unref()
  appendFileSync(SERVE_PIDS, `${child.pid}\n`)
}
if (SERVE_MODE === 'never') setInterval(() => {}, 1000)
else createServer((_, res) => res.end('ok')).listen(Number(AWAYWORK_PORT), '127.0.0.1')
