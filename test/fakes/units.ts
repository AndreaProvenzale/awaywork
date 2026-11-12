import { mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execa } from 'execa'
import { parseConfig } from '../../src/config/load.js'
import { bin, builtinSkillsDir } from '../../src/config/paths.js'
import { allowance } from '../../src/core/budget.js'
import type { Left } from '../../src/core/footer.js'
import { planRun } from '../../src/core/foreman.js'
import { builtinSkills } from '../../src/core/skills.js'
import type { Forge, Item, Provider, Quota, Source, Write } from '../../src/core/types.js'
import { type RunInput, runUnits } from '../../src/worker/units.js'
import { withRepos } from './acme.js'
import { fakeForge } from './forge.js'
import { fakeProvider } from './provider.js'
import { fakeSource } from './source.js'

// publish amends commits, which needs a committer identity even on a bare CI runner
process.env.GIT_COMMITTER_NAME ??= 't'
process.env.GIT_COMMITTER_EMAIL ??= 't@t'

export const git = (dir: string, ...args: string[]) =>
  execa(bin('git'), ['-C', dir, '-c', 'user.name=t', '-c', 'user.email=t@t', ...args])

export const reset = new Date(2026, 8, 26, 3).getTime() / 1000

export const quota = (long: number): Quota => ({
  windows: [
    { name: 'five_hour', span: 'short', used: 0.1, resetsAt: 1790254200 },
    { name: 'seven_day', span: 'long', used: long, resetsAt: reset },
  ],
})

export const models: (string | undefined)[] = []

export const envs: NodeJS.ProcessEnv[] = []

/** Commits and writes a PR body, or writes a report, as a model would; the week fills to 45%. */
export const worker: Provider = {
  ...fakeProvider('claude'),
  async *run(job) {
    models.push(job.model)
    envs.push(job.env)
    const out = join(job.dir, '.away/out')
    if (job.unit.deliver === 'report') {
      await writeFile(join(out, 'report.md'), 'Approve.')
      await writeFile(join(out, 'verdict'), 'Approve\n')
    } else {
      await writeFile(join(job.dir, 'fix.txt'), 'fixed')
      await git(job.dir, 'add', 'fix.txt')
      await git(job.dir, 'commit', '-qm', 'Fix the build')
      await writeFile(join(out, 'pr.md'), 'Fix the build\n\nRan the failing test.')
    }
    yield { type: 'log', line: 'working' }
    yield { type: 'quota', quota: quota(0.45) }
    yield { type: 'done', ok: true, turns: 5 }
  },
}

/** Clones from and pushes to a local `origin` on `main`, recording each draft PR it opens. */
export async function originForge(root: string) {
  const origin = join(root, 'origin')
  await execa(bin('git'), ['init', '-q', '-b', 'main', origin])
  await git(origin, 'commit', '-q', '--allow-empty', '-m', 'init')
  const opened: { head: string; base: string; body: string; left?: Left }[] = []
  const updated: { pr: number; body: string; ready: boolean; left?: Left }[] = []
  const readied = new Set<number>()
  const fake = fakeForge()
  const forge = {
    ...fake,
    clone: async (_repo: string, branch: string, dir: string) => {
      await execa(bin('git'), ['clone', '-q', ...(branch ? ['--branch', branch] : []), origin, dir])
    },
    push: async (dir: string, branch: string, opts: { repo: string }) => {
      await fake.push(dir, branch, opts)
      await git(dir, 'push', '-q', origin, `HEAD:refs/heads/${branch}`)
    },
    fastForward: async (
      dir: string,
      branch: string,
      from: string,
      to: { pr: number; draft?: unknown },
    ) => {
      if (to.draft && readied.has(to.pr)) return `#${to.pr} was marked ready`
      const head = await git(origin, 'rev-parse', `refs/heads/${branch}`)
      if (head.stdout !== from) return `${branch} moved`
      await git(dir, 'push', '-q', origin, `HEAD:refs/heads/${branch}`)
    },
    openPr: async (
      repo: string,
      head: string,
      base: string,
      bodyFile: string,
      _runId: string,
      _items: unknown,
      _draft: boolean,
      left?: Left,
    ) => {
      opened.push({ head, base, body: await readFile(bodyFile, 'utf8'), ...(left && { left }) })
      return `https://example.com/${repo}/pull/${head}`
    },
    updatePr: async (
      _repo: string,
      pr: number,
      bodyFile: string,
      _runId: string,
      _items: unknown,
      ready: boolean,
      left?: Left,
    ) => {
      updated.push({ pr, body: await readFile(bodyFile, 'utf8'), ready, ...(left && { left }) })
    },
  }
  return { origin, opened, updated, readied, forge }
}

/** Commits `<unit id>.txt` and writes a PR body, or writes a report. */
export const committer: Provider = {
  ...fakeProvider('claude'),
  async *run(job) {
    const out = join(job.dir, '.away/out')
    if (job.unit.deliver === 'report') await writeFile(join(out, 'report.md'), 'Approve.')
    else {
      await writeFile(join(job.dir, `${job.unit.id}.txt`), 'done')
      await git(job.dir, 'add', `${job.unit.id}.txt`)
      await git(job.dir, 'commit', '-qm', `Work on ${job.unit.id}`)
      await writeFile(join(out, 'pr.md'), `Work on ${job.unit.id}\n\nDone.`)
    }
    yield { type: 'done', ok: true, turns: 1 }
  },
}

/** Three days before `quota`'s weekly reset. */
export const week = reset * 1000 - 3 * 24 * 60 * 60 * 1000

/** Commits and keeps a PR body current; reviews and QA write a report and a verdict from `verdicts`. */
export function looper(
  verdicts: Record<string, string>,
  seen: Record<string, string[]> = {},
): Provider {
  return {
    ...fakeProvider('claude'),
    async *run(job) {
      const previous = join(job.dir, '.away/context/previous')
      seen[job.unit.id] = (await readdir(previous).catch(() => [])).sort()
      const out = join(job.dir, '.away/out')
      const verdict = verdicts[job.unit.id]
      if (job.unit.deliver === 'report') {
        await writeFile(join(out, 'report.md'), `${job.unit.id} says ${verdict ?? 'nothing'}.`)
        if (verdict) await writeFile(join(out, 'verdict'), `${verdict}\n`)
      } else {
        await writeFile(join(job.dir, `${job.unit.id}.txt`), 'done')
        await git(job.dir, 'add', '.')
        await git(job.dir, 'commit', '-qm', `Work on ${job.unit.id}`)
        await writeFile(join(out, 'pr.md'), 'Add rate limits\n\nDone.')
      }
      yield { type: 'done', ok: true, turns: 1 }
    },
  }
}

/** Plans `yaml` for `items` and runs it against a local origin. */
export async function loopRun(
  yaml: string,
  items: Item[],
  provider: Provider,
  {
    forge: overrides,
    ...input
  }: Omit<Partial<RunInput>, 'forge'> & { forge?: Partial<Forge> } = {},
) {
  const root = await mkdtemp(join(tmpdir(), 'awaywork-loop-'))
  const { origin, opened, forge } = await originForge(root)
  for (const branch of new Set(items.flatMap((i) => i.linkedPrs.map((pr) => pr.branch))))
    await git(origin, 'branch', branch)
  const config = parseConfig(`providers: [claude: {}]
sources: { github: {} }
${withRepos(yaml)}`)
  const plan = planRun({
    config,
    items,
    allowances: { claude: allowance(config.budget, quota(0.36), week, config.windows) },
    skills: { builtin: builtinSkills },
  })
  const report = await runUnits({
    config,
    configDir: root,
    plan,
    runId: 'r1',
    runDir: join(root, 'run'),
    dryRun: false,
    providers: { claude: provider },
    sources: { github: fakeSource() as Source },
    forge: { ...forge, ...overrides },
    ctx: { env: {}, log: () => {} },
    watch: () => ({ stop: async () => {} }),
    shortage: async () => undefined,
    skillDirs: { user: join(root, 'none'), builtin: builtinSkillsDir },
    ...input,
  })
  return { report, opened, origin }
}

/** Runs `queue` on `items` with GitHub and tracker sources that record what on_done writes, or fail as `write` does. */
export async function finishedRun(
  queue: string,
  items: Item[],
  provider = looper({}),
  write?: Source['write'] | null,
  ownDraftsRefused?: string,
  threads?: Forge['threads'],
  only?: { named: string; skill: string },
) {
  const root = await mkdtemp(join(tmpdir(), 'awaywork-done-'))
  const { origin, forge, opened, updated } = await originForge(root)
  await git(origin, 'branch', 'feature-2')
  const config = parseConfig(`
providers: [claude: {}]
repos: { acme/*: {} }
sources: { github: {}, tracker: { command: 'echo []', write: 'true' } }
queue:
${queue}
`)
  const plan = planRun({
    config,
    items,
    allowances: { claude: allowance(config.budget, null, 0, config.windows) },
    skills: { builtin: builtinSkills },
    only,
  })
  const writes: [string, Write][] = []
  const lines: string[] = []
  const source = {
    ...fakeSource(),
    secrets: () => ['SRC_TOKEN'],
    write:
      write === null
        ? undefined
        : (write ??
          (async (_cfg: unknown, item: Item, w: Write) => {
            writes.push([item.key, w])
            return { before: '2026-10-24T00:00:00Z', after: '2026-10-25T01:00:00Z' }
          })),
  }
  const report = await runUnits({
    config,
    configDir: root,
    plan,
    runId: 'r1',
    runDir: join(root, 'run'),
    dryRun: false,
    providers: { claude: provider },
    sources: { github: source as Source, tracker: source as Source },
    forge: { ...forge, ownDraftsRefused, threads },
    ctx: { env: { PATH: process.env.PATH, SRC_TOKEN: 's3cret' }, log: (line) => lines.push(line) },
    watch: () => ({ stop: async () => {} }),
    shortage: async () => undefined,
    skillDirs: { user: join(root, 'none'), builtin: builtinSkillsDir },
  })
  return { report, writes, lines, opened, updated }
}

/** A provider whose step writes `questions.md` unless empty and `status` when given, and commits first when `commits`. */
export const asker = (questions: string, commits = false, status?: string): Provider => ({
  ...fakeProvider('claude'),
  async *run(job) {
    if (commits) {
      await writeFile(join(job.dir, 'a.txt'), 'a')
      await git(job.dir, 'add', '.')
      await git(job.dir, 'commit', '-qm', 'Add a')
      await writeFile(join(job.dir, '.away/out/pr.md'), 'Add a\n\nDone.')
    }
    if (questions) await writeFile(join(job.dir, '.away/out/questions.md'), questions)
    if (status) await writeFile(join(job.dir, '.away/out/status'), status)
    yield { type: 'done', ok: true, turns: 1 }
  },
})
