#!/usr/bin/env node
// Stands in for `claude` in the live story: answers the quota probe, and plays each task's part by the skill and task its prompt names.
import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

const args = process.argv.slice(2)
if (args.includes('--version')) {
  console.log('2.1.282 (Claude Code)')
  process.exit(0)
}
const probe = readFileSync(new URL('../fixtures/claude/probe.jsonl', import.meta.url), 'utf8')
if (args.includes('claude-haiku-4-5-20251001')) {
  process.stdout.write(probe)
  process.exit(0)
}

const prompt = args[args.indexOf('-p') + 1] ?? ''
const [, unit = '', skill = ''] = /Unit `([^`]+)`, skill `([^`]+)`/.exec(prompt) ?? []
const task = unit.split('-').at(-1)
const resumed = prompt.includes("the branch of awaywork's own draft")
const out = (file, text) => writeFileSync(`.away/out/${file}`, text)
const git = (...a) => execFileSync('git', a)
const commit = (file, text, message) => {
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, text)
  git('add', file)
  git('commit', '-qm', message)
}

if (skill === 'plan') {
  out('report.md', 'The story: an endpoint with its migration, then the rest around it.')
  out('plan.yml', process.env.FAKE_PLAN ?? '')
} else if (skill === 'qa-evidence') {
  out('report.md', 'Export screen: CSV downloads, 3 screenshots attached.')
  out('status', 'done\n')
} else {
  const goesOn = (process.env.FAKE_CONTINUE ?? '').split(',').includes(task)
  const file = task === 'api' ? `migrations/${unit}.sql` : `story/${unit}.md`
  // Only api's commits run the sandbox's CI, which a later task waits on.
  const ci = task === 'api' ? '' : ' [skip ci]'
  commit(resumed ? `story/${unit}-more.md` : file, `${task}\n`, `${task}: step${ci}`)
  out('pr.md', `Story ${task}\n\nDone.`)
  out('status', goesOn && !resumed ? 'continue\n' : 'done\n')
}
// A real run reports its quota mid-stream, before the result.
console.log(probe.split('\n').find((line) => line.includes('"rate_limit_event"')))
console.log(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, num_turns: 1 }))
