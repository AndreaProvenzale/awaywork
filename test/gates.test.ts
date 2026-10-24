import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
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
import { gatesSection, runGates, runJudges } from '../src/worker/gates.js'
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
      Object.entries(gates).map(([name, g]) => [
        name,
        { changed: [], commands: [], skills: [], ...g },
      ]),
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
  risk: { skill: judge }
repos:
  acme/api:
    gates:
      schema: { changed: "src/db/schema/**" }
      routes: { command: scripts/api-routes.sh }
      queues: { changed: ["src/jobs/**"] }
      risk: { skill: our-judge }
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
    schema: { changed: ['**/migrations/**', 'src/db/schema/**'], commands: [], skills: [] },
    routes: {
      changed: [],
      commands: ['scripts/route-diff.sh', 'scripts/api-routes.sh'],
      skills: [],
    },
    risk: { changed: [], commands: [], skills: ['judge', 'our-judge'] },
    queues: { changed: ['src/jobs/**'], commands: [], skills: [] },
  })
  expect(gatesOf('acme/web')).toEqual({
    schema: { changed: ['**/migrations/**'], commands: [], skills: [] },
    routes: { changed: [], commands: ['scripts/route-diff.sh'], skills: [] },
    risk: { changed: [], commands: [], skills: ['judge'] },
  })
})

it('takes one of changed, command or skill per gate, each with something in it', () => {
  const problems = (gates: string) => {
    try {
      parseConfig(
        `providers: [claude: {}]\nsources: { github: { repos: [acme/*] } }\ngates: ${gates}\n`,
      )
      return []
    } catch (e) {
      return (e as ConfigError).problems
    }
  }
  expect(problems('{ deps: { changed: package.json, command: "true" } }')).toEqual([
    'gates.deps: expected one of changed, command or skill',
  ])
  expect(problems('{ deps: { command: "true", skill: judge } }')).toEqual([
    'gates.deps: expected one of changed, command or skill',
  ])
  expect(problems('{ deps: {} }')).toEqual(['gates.deps: expected changed, command or skill'])
  expect(problems('{ deps: { changed: [] } }')).toEqual([
    'gates.deps.changed: expected at least one glob',
  ])
  expect(problems('{ deps: { command: "" } }')).toEqual([
    expect.stringMatching(/^gates\.deps\.command: Too small/),
  ])
  expect(problems('{ "my gate": { changed: a } }')).toEqual([
    'gates.my gate: expected a name like schema',
  ])
  expect(problems('{ deps: false }')).not.toEqual([])
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
  expect(await runGates(answering({}), gates, dir, from, from)).toEqual([
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
  expect(await runGates(check, gates, dir, from, from)).toEqual([
    { name: 'routes', line: '+ GET /exports/vat   + POST /exports/vat/retry' },
    { name: 'quiet', line: 'Command failed with exit code 127: scripts/quiet.sh' },
  ])
  expect(check).toHaveBeenCalledWith('scripts/clean.sh', gates, dir, expect.any(Function), {
    from,
    gate: true,
  })
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
  expect(await runGates(check, gates, dir, from, from)).toEqual([
    { name: 'a', line: '`slow` not checked: timed out after 15 min' },
    { name: 'b', line: '`cut` not checked: the window ended' },
    { name: 'c', line: "`refused` not checked: not run on an untrusted author's PR" },
  ])
})

it('fires a gate whose command names a file the commits added, without running it', async () => {
  const { dir, from } = await committed(['scripts/route-diff.sh', 'src/app.ts'])
  const check = answering({})
  const gates = unit({ routes: { commands: ['bash ./scripts/route-diff.sh --base main'] } })
  expect(await runGates(check, gates, dir, from, from)).toEqual([
    { name: 'routes', line: '`scripts/route-diff.sh` changed, not run' },
  ])
  expect(check).not.toHaveBeenCalled()
})

/** The line of a gate running `command` once `change` ran on a clone whose start holds `scripts/gate.sh`, and whether it ran. */
async function afterChange(command: string, change: (dir: string) => Promise<unknown>) {
  const { dir } = await committed(['scripts/gate.sh'])
  const start = await git(dir, 'rev-parse', 'HEAD')
  await change(dir)
  // The slice starts at the clone's tip, as a stacked one does: its own commits change nothing.
  const from = await git(dir, 'rev-parse', 'HEAD')
  const check = answering({})
  const fired = await runGates(check, unit({ routes: { commands: [command] } }), dir, from, start)
  return { line: fired[0]?.line, ran: check.mock.calls.length > 0 }
}

it('fires, without running it, a command whose script differs from the one the chain started with', async () => {
  const swapped = { line: '`scripts/gate.sh` changed, not run', ran: false }
  const gate = 'sh scripts/gate.sh'
  expect(await afterChange(gate, async () => {})).toEqual({ line: undefined, ran: true })
  const earlierSlice = async (dir: string) => {
    await writeFile(join(dir, 'scripts/gate.sh'), 'exit 0\n')
    await git(dir, 'commit', '-qam', 'swap')
  }
  expect(await afterChange(gate, earlierSlice)).toEqual(swapped)
  const hidden = async (dir: string) => {
    await git(dir, 'update-index', '--skip-worktree', 'scripts/gate.sh')
    await writeFile(join(dir, 'scripts/gate.sh'), 'y')
  }
  expect(await afterChange(gate, hidden)).toEqual(swapped)
  expect(await afterChange(gate, (dir) => rm(join(dir, 'scripts/gate.sh')))).toEqual(swapped)
  const added = (dir: string) => writeFile(join(dir, 'scripts/new.sh'), 'exit 0\n')
  expect(await afterChange('sh scripts/new.sh', added)).toEqual({
    line: '`scripts/new.sh` changed, not run',
    ran: false,
  })
})

it('finds the script among shell punctuation, by its path from the repo root', async () => {
  const edit = (dir: string) => writeFile(join(dir, 'scripts/gate.sh'), 'exit 0\n')
  for (const command of [
    '(./scripts/gate.sh)&&echo ok',
    'scripts/gate.sh>out',
    '"scripts/gate.sh"; true',
    'true || scripts/gate.sh | cat',
  ])
    expect(await afterChange(command, edit)).toMatchObject({ ran: false })
  expect(await afterChange('cd scripts && sh gate.sh', edit)).toMatchObject({ ran: true })
})

it('fires a gate once when both its globs and its command do, and escapes a <', async () => {
  const { dir, from } = await committed(['db/migrations/1.ts'])
  const check = answering({
    'scripts/schema.sh': { output: '', stdout: '<!-- drops users', failed: 'exit 1' },
  })
  const gates = unit({
    schema: { changed: ['**/migrations/**'], commands: ['scripts/schema.sh'] },
  })
  expect(await runGates(check, gates, dir, from, from)).toEqual([
    { name: 'schema', line: 'db/migrations/1.ts; &lt;!-- drops users' },
  ])
})

it('passes when no gate fires, and has nothing to run without gates', async () => {
  const { dir, from } = await committed(['src/app.ts'])
  const gates = unit({ schema: { changed: ['**/migrations/**'] }, ok: { commands: ['true'] } })
  expect(await runGates(answering({}), gates, dir, from, from)).toEqual([])
  expect(await runGates(answering({}), {} as Unit, dir, from, from)).toEqual([])
})

it('lays out the decision card, or the gates that ran when none fired', () => {
  const gates = ['schema', 'deps', 'routes']
  expect(
    gatesSection(gates, [
      { name: 'schema', line: 'migrations/20261023_add_vat_mode.ts' },
      { name: 'routes', line: '+ GET /exports/vat   + POST /exports/vat/retry' },
    ]),
  ).toBe(
    '## Needs a decision\n\n### Gates (from scripts)\n\n- schema: migrations/20261023_add_vat_mode.ts\n- routes: + GET /exports/vat   + POST /exports/vat/retry\n\n---',
  )
  expect(gatesSection(gates, [])).toBe('Gates: none fired (schema, deps, routes)\n\n---')
})

it('puts the judges after the scripts, in a part of their own, and a card with only theirs', () => {
  const judged = { name: 'risk', line: 'VAT rounding moved to each line', judged: true as const }
  expect(gatesSection(['schema', 'risk'], [{ name: 'schema', line: 'db/1.sql' }, judged])).toBe(
    '## Needs a decision\n\n### Gates (from scripts)\n\n- schema: db/1.sql\n\n### Judge\n\n- risk: VAT rounding moved to each line\n\n---',
  )
  expect(gatesSection(['risk'], [judged])).toBe(
    '## Needs a decision\n\n### Judge\n\n- risk: VAT rounding moved to each line\n\n---',
  )
})

/** A clone whose slice since `from` adds `src/app.ts`, with its PR body in `.away/out/`, which git ignores. */
async function slice() {
  const { dir, from } = await committed(['src/app.ts'])
  await writeFile(join(dir, '.git/info/exclude'), '/.away/\n')
  await mkdir(join(dir, '.away/out'), { recursive: true })
  await writeFile(join(dir, '.away/out/pr.md'), 'Add VAT\n\nDone.\n')
  await writeFile(join(dir, '.away/out/diff.patch'), 'the diff\n')
  return { dir, from }
}

/** A judge that does `act` in the clone, then leaves `verdict` and `report`, and says why it didn't run, if so. */
const judging = (
  verdict: string,
  report = '',
  act: (dir: string) => Promise<unknown> = async () => {},
  why?: string,
) =>
  vi.fn(async (_gate: string, _skill: string, _unit: Unit, dir: string) => {
    await act(dir)
    await writeFile(join(dir, '.away/out/verdict'), `${verdict}\n`)
    await writeFile(join(dir, '.away/out/report.md'), report)
    return why
  })

it("fires a gate on its judge's verdict, with the report's lines, and runs every judge it has", async () => {
  const { dir, from } = await slice()
  const gates = unit({ risk: { skills: ['judge', 'our-judge'] }, ok: { skills: ['judge'] } })
  const judge = vi.fn(
    async (gate: string, skill: string, _unit: Unit, dir: string, _from: string) => {
      const fires = gate === 'risk' && skill === 'our-judge'
      await writeFile(join(dir, '.away/out/verdict'), fires ? 'fires\n' : 'clear\n')
      await writeFile(
        join(dir, '.away/out/report.md'),
        '- VAT rounding moved to each line → totals change\n\n* <!-- the rest\n',
      )
      return undefined
    },
  )
  expect(await runJudges(judge, gates, dir, from)).toEqual([
    { name: 'risk', line: 'VAT rounding moved to each line → totals change', judged: true },
    { name: 'risk', line: '&lt;!-- the rest', judged: true },
  ])
  expect(judge.mock.calls.map((c) => [c[0], c[1], c[4]])).toEqual([
    ['risk', 'judge', from],
    ['risk', 'our-judge', from],
    ['ok', 'judge', from],
  ])
  const quiet = judging('fires')
  expect(await runJudges(quiet, unit({ risk: { skills: ['judge'] } }), dir, from)).toEqual([
    { name: 'risk', line: 'fired, with no report', judged: true },
  ])
})

it('drops what a judge changed in the clone, and fires its gate whatever it says', async () => {
  for (const act of [
    async (dir: string) => {
      await writeFile(join(dir, 'src/app.ts'), 'y')
      await git(dir, 'commit', '-qam', 'judged')
    },
    (dir: string) => writeFile(join(dir, '.away/out/pr.md'), 'Add VAT\n\nReviewed: safe.\n'),
    (dir: string) => writeFile(join(dir, '.away/out/extra.md'), 'x'),
    async (dir: string) => {
      await rm(join(dir, '.away/out'), { recursive: true })
      await mkdir(join(dir, '.away/out'))
    },
    (dir: string) => writeFile(join(dir, 'src/app.ts'), 'y'),
    async (dir: string) => {
      await writeFile(join(dir, 'src/new.ts'), 'y')
      await git(dir, 'add', 'src/new.ts')
    },
  ]) {
    const { dir, from } = await slice()
    const tip = await git(dir, 'rev-parse', 'HEAD')
    const judge = judging('clear', '', act)
    expect(await runJudges(judge, unit({ risk: { skills: ['judge'] } }), dir, from)).toEqual([
      {
        name: 'risk',
        line: 'the judge changed the clone; awaywork dropped its changes',
        judged: true,
      },
    ])
    expect(await git(dir, 'rev-parse', 'HEAD')).toBe(tip)
    expect(await git(dir, 'status', '--porcelain')).toBe('')
    expect(await readFile(join(dir, '.away/out/pr.md'), 'utf8')).toBe('Add VAT\n\nDone.\n')
    expect((await readdir(join(dir, '.away/out'))).sort()).toEqual(['diff.patch', 'pr.md'])
  }
})

it("fails closed: a judge that didn't run or finish fires, whatever it wrote", async () => {
  const { dir, from } = await slice()
  const judge = judging('clear', '', async () => {}, 'reached the window end')
  expect(await runJudges(judge, unit({ risk: { skills: ['judge'] } }), dir, from)).toEqual([
    { name: 'risk', line: "judge didn't run: reached the window end", judged: true },
  ])
})
