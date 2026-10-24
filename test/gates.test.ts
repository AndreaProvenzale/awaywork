import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execa } from 'execa'
import { expect, it, vi } from 'vitest'
import { type ConfigError, parseConfig } from '../src/config/load.js'
import { bin } from '../src/config/paths.js'
import { allowance } from '../src/core/budget.js'
import { planRun } from '../src/core/foreman.js'
import { builtinSkills } from '../src/core/skills.js'
import type { Gate, Unit } from '../src/core/types.js'
import type { Check } from '../src/worker/checks.js'
import { decisionCard, runGates } from '../src/worker/gates.js'
import { fakeItem } from './fakes/items.js'

const git = async (dir: string, ...args: string[]) =>
  (await execa(bin('git'), ['-C', dir, '-c', 'user.name=t', '-c', 'user.email=t@t', ...args]))
    .stdout

/** A repo whose commits since the returned `from` add `files`. */
async function committed(files: string[]) {
  const dir = await mkdtemp(join(tmpdir(), 'awaywork-gates-'))
  await execa(bin('git'), ['init', '-q', '-b', 'main', dir])
  await git(dir, 'commit', '-q', '--allow-empty', '-m', 'init')
  const from = await git(dir, 'rev-parse', 'HEAD')
  for (const file of files) {
    await mkdir(join(dir, file, '..'), { recursive: true })
    await writeFile(join(dir, file), 'x')
  }
  await git(dir, 'add', '.')
  await git(dir, 'commit', '-q', '-m', 'work')
  return { dir, from }
}

const unit = (gates: Record<string, Partial<Gate>>) =>
  ({
    gates: Object.fromEntries(
      Object.entries(gates).map(([name, g]) => [name, { changed: [], commands: [], ...g }]),
    ),
  }) as unknown as Unit

/** A check that answers each command from `results`, passing the others. */
const answering = (results: Record<string, Check>) =>
  vi.fn(async (command: string) => results[command] ?? { output: '', stdout: '' })

it("unions a repo's gates with the top-level ones, and adds the repo's own", () => {
  const config = parseConfig(`
providers: [claude: {}]
sources: { github: { repos: [acme/*] } }
gates:
  schema: { changed: ["**/migrations/**"] }
  routes: { command: scripts/route-diff.sh }
repos:
  acme/api:
    gates:
      schema: { changed: "src/db/schema/**" }
      routes: { command: scripts/api-routes.sh }
      queues: { changed: ["src/jobs/**"] }
queue: [{ skill: implement }]
`)
  const issue = (repo: string) =>
    fakeItem({ source: 'github', key: `${repo}#1`, type: 'issue', fields: { repo } })
  const plan = planRun({
    config,
    items: [issue('acme/api'), issue('acme/web')],
    allowances: { claude: allowance(config.budget, null, 0, config.windows) },
    skills: { builtin: builtinSkills },
  })
  const gatesOf = (repo: string) => plan.units.find((p) => p.unit.repo === repo)?.unit.gates
  expect(gatesOf('acme/api')).toEqual({
    schema: { changed: ['**/migrations/**', 'src/db/schema/**'], commands: [] },
    routes: { changed: [], commands: ['scripts/route-diff.sh', 'scripts/api-routes.sh'] },
    queues: { changed: ['src/jobs/**'], commands: [] },
  })
  expect(gatesOf('acme/web')).toEqual({
    schema: { changed: ['**/migrations/**'], commands: [] },
    routes: { changed: [], commands: ['scripts/route-diff.sh'] },
  })
})

it('takes one of changed or command per gate', () => {
  const problems = (gate: string) => {
    try {
      parseConfig(
        `providers: [claude: {}]\nsources: { github: { repos: [acme/*] } }\ngates: { deps: ${gate} }\n`,
      )
      return []
    } catch (e) {
      return (e as ConfigError).problems
    }
  }
  expect(problems('{ changed: package.json, command: "true" }')).toEqual([
    expect.stringContaining('expected changed or command, not both'),
  ])
  expect(problems('{}')).toEqual([expect.stringContaining('expected changed or command')])
  expect(problems('false')).not.toEqual([])
})

it('fires a changed gate on the paths the commits change, listing a few', async () => {
  const { dir, from } = await committed([
    'db/migrations/1.ts',
    'db/migrations/2.ts',
    'db/migrations/3.ts',
    'db/migrations/4.ts',
    'db/migrations/5.ts',
    'src/app.ts',
  ])
  const gates = unit({ schema: { changed: ['**/migrations/**'] }, deps: { changed: ['*.json'] } })
  expect(await runGates(answering({}), gates, dir, from)).toEqual([
    {
      name: 'schema',
      line: 'db/migrations/1.ts, db/migrations/2.ts, db/migrations/3.ts and 2 more',
    },
  ])
})

it('fires a command gate on a non-zero exit, with its stdout on one line, else what failed', async () => {
  const { dir, from } = await committed(['src/app.ts'])
  const check = answering({
    'scripts/route-diff.sh': {
      output: 'warning: slow\n+ GET /exports/vat\n+ POST /exports/vat/retry',
      stdout: '+ GET /exports/vat\n+ POST /exports/vat/retry\n',
      failed: 'Command failed with exit code 1: scripts/route-diff.sh',
    },
    'scripts/quiet.sh': {
      output: 'sh: scripts/quiet.sh: not found',
      stdout: '',
      failed: 'Command failed with exit code 127: scripts/quiet.sh',
    },
  })
  const gates = unit({
    routes: { commands: ['scripts/route-diff.sh'] },
    quiet: { commands: ['scripts/quiet.sh'] },
    clean: { commands: ['scripts/clean.sh'] },
  })
  expect(await runGates(check, gates, dir, from)).toEqual([
    { name: 'routes', line: '+ GET /exports/vat   + POST /exports/vat/retry' },
    { name: 'quiet', line: 'Command failed with exit code 127: scripts/quiet.sh' },
  ])
  expect(check).toHaveBeenCalledWith('scripts/clean.sh', gates, dir, expect.any(Function), false)
})

it("fails closed: a command that times out, is stopped or isn't run fires", async () => {
  const { dir, from } = await committed(['src/app.ts'])
  const check = answering({
    slow: {
      output: 'started',
      stdout: 'started',
      failed: 'timed out after 15 min',
      timedOut: true,
    },
    cut: { output: '', stdout: '', failed: 'the window ended', stopped: true },
    refused: { output: '', failed: "not run on an untrusted author's PR", refused: true },
  })
  const gates = unit({
    a: { commands: ['slow'] },
    b: { commands: ['cut'] },
    c: { commands: ['refused'] },
  })
  expect(await runGates(check, gates, dir, from)).toEqual([
    { name: 'a', line: '`slow` not checked: timed out after 15 min' },
    { name: 'b', line: '`cut` not checked: the window ended' },
    { name: 'c', line: "`refused` not checked: not run on an untrusted author's PR" },
  ])
})

it('fires a gate whose command names a file the commits changed, without running it', async () => {
  const { dir, from } = await committed(['scripts/route-diff.sh', 'src/app.ts'])
  const check = answering({})
  const gates = unit({ routes: { commands: ['bash ./scripts/route-diff.sh --base main'] } })
  expect(await runGates(check, gates, dir, from)).toEqual([
    { name: 'routes', line: '`scripts/route-diff.sh` changed in this PR' },
  ])
  expect(check).not.toHaveBeenCalled()
})

it('fires a gate once when both its globs and its command do, and escapes a <', async () => {
  const { dir, from } = await committed(['db/migrations/1.ts'])
  const check = answering({
    'scripts/schema.sh': { output: '', stdout: '<!-- drops users', failed: 'exit 1' },
  })
  const gates = unit({
    schema: { changed: ['**/migrations/**'], commands: ['scripts/schema.sh'] },
  })
  expect(await runGates(check, gates, dir, from)).toEqual([
    { name: 'schema', line: 'db/migrations/1.ts; &lt;!-- drops users' },
  ])
})

it('passes when no gate fires, and has nothing to run without gates', async () => {
  const { dir, from } = await committed(['src/app.ts'])
  const gates = unit({ schema: { changed: ['**/migrations/**'] }, ok: { commands: ['true'] } })
  expect(await runGates(answering({}), gates, dir, from)).toEqual([])
  expect(await runGates(answering({}), {} as Unit, dir, from)).toEqual([])
})

it('lays out the decision card', () => {
  expect(
    decisionCard([
      { name: 'schema', line: 'migrations/20261023_add_vat_mode.ts' },
      { name: 'routes', line: '+ GET /exports/vat   + POST /exports/vat/retry' },
    ]),
  ).toBe(
    '## Needs a decision\n\n### Gates (from scripts)\n\n- schema: migrations/20261023_add_vat_mode.ts\n- routes: + GET /exports/vat   + POST /exports/vat/retry',
  )
})
