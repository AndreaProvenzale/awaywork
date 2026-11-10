#!/usr/bin/env node
// Stands in for `claude` in the demo: a quota reading for the probe, and a scripted worker per unit, never a model call.
import { execFileSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

const args = process.argv.slice(2)
const say = (event) => console.log(JSON.stringify(event))
const now = Math.floor(Date.now() / 1000)
const quota = (used) => ({
  type: 'rate_limit_event',
  rate_limit_info: {
    status: 'allowed',
    resetsAt: now + 4 * 3600,
    rateLimitType: 'five_hour',
    unifiedWindows: {
      five_hour: { utilization: used / 3, resetsAt: now + 4 * 3600 },
      seven_day: { utilization: used, resetsAt: now + 3 * 86400 },
    },
  },
})

const out = (file, ...lines) => writeFileSync(`.away/out/${file}`, `${lines.join('\n')}\n`)
const commit = (file, message, ...lines) => {
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, `${lines.join('\n')}\n`)
  execFileSync('git', ['add', file])
  execFileSync('git', ['commit', '-qm', message])
}

const units = {
  'acme-api-1': () => {
    commit(
      'src/limit.ts',
      'Answer bursts with 429',
      'export const limit = 10',
      'export const burst = 20',
      '',
      'export const retryAfter = (refillMs: number) => Math.ceil(refillMs / 1000)',
    )
    out(
      'pr.md',
      'Answer bursts with a 429, not a 500',
      '',
      'Rate limits the public API with a token bucket per client key; bursts get a 429 with Retry-After instead of a 500.',
    )
    return 14
  },
  'acme-api-2': () => {
    out(
      'report.md',
      'Approve: the session cache keys on the user id and expires with the token.',
      '',
      '## What I checked',
      '',
      '- `SessionCache.get` misses on a revoked token: the key carries its `jti`.',
      "- The TTL is the token's own `exp`, so a refresh never serves a stale session.",
      '- The Redis client reuses the pool from `src/db.ts`; no extra connections.',
      '',
      '## Nits',
      '',
      '- `src/session.ts:41` logs the whole session on a miss; the user id is enough.',
    )
    out('verdict', 'approve')
    return 6
  },
  't-4': () => {
    commit(
      'src/invoices/export.ts',
      'Export invoices as CSV',
      "import { listInvoices } from './store'",
      '',
      "const header = 'number,customer,issued,total'",
      '',
      'export async function* invoicesCsv(account: string) {',
      '  yield `${header}\\n`',
      '  for await (const i of listInvoices(account))',
      '    yield `${i.number},${i.customer},${i.issued},${i.total}\\n`',
      '}',
    )
    out(
      'pr.md',
      'Export invoices as CSV',
      '',
      'Adds GET /invoices.csv, streaming one row per invoice with a header row.',
    )
    return 21
  },
  't-9': () => {
    commit(
      'src/webhooks/retry.ts',
      'Retry webhooks on 5xx',
      'export const backoffMs = (attempt: number) => Math.min(60_000, 500 * 2 ** attempt)',
      'export const retries = (status: number) => (status >= 500 ? 5 : 0)',
    )
    out(
      'pr.md',
      'Retry webhooks on 5xx',
      '',
      'Retries a delivery that got a 5xx up to five times, backing off from 500 ms to a minute.',
    )
    return 17
  },
  't-7': () => {
    out(
      'questions.md',
      'Should dark mode follow the system setting, or be a toggle in settings only?',
    )
    out('status', 'ask')
    return 4
  },
}

if (args.includes('--version')) console.log('2.1.282 (Claude Code)')
else if (args[0] === 'auth') console.log('{"loggedIn":true,"authMethod":"oauth_token"}')
else if (args.includes('claude-haiku-4-5-20251001')) {
  say(quota(0.12))
  say({ type: 'result', subtype: 'success', is_error: false, num_turns: 1 })
} else {
  const prompt = args[args.indexOf('-p') + 1] ?? ''
  const [, unit = ''] = /Unit `([^`]+)`/.exec(prompt) ?? []
  const turns = units[unit]?.() ?? 1
  if (unit !== 't-7') out('status', 'done')
  say(quota(0.14))
  say({ type: 'result', subtype: 'success', is_error: false, num_turns: turns })
}
