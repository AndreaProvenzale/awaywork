import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execa } from 'execa'
import { afterEach, expect, it } from 'vitest'
import { bin } from '../src/config/paths.js'
import { discard, handOff, snapshot } from '../src/worker/steps.js'

let root = ''
const before = process.env.GIT_CONFIG_GLOBAL
afterEach(async () => {
  if (before === undefined) delete process.env.GIT_CONFIG_GLOBAL
  else process.env.GIT_CONFIG_GLOBAL = before
  await rm(root, { recursive: true, force: true })
})

/** A clone with a submodule at `name` (BADBYTE: `s\xff`) whose own config names filters and an external diff; a stat-dirty file in it. */
async function clone(name: string) {
  root = await mkdtemp(join(tmpdir(), 'awaywork-steps-'))
  const ran = join(root, 'ran')
  await writeFile(
    join(root, 'make.sh'),
    `set -e
n=$1; [ "$n" = BADBYTE ] && n=$'s\\xff'
g() { git -c user.name=t -c user.email=t@t -c protocol.file.allow=always "$@"; }
g init -q -b main lib && echo a > lib/a.txt && echo '* filter=evil diff=evil' > lib/.gitattributes && g -C lib add -A && g -C lib commit -qm lib
g init -q -b main c && echo hi > c/README && g -C c add README && mkdir -p c/.away/out
g -C c submodule add -q "$PWD/lib" "$n" && g -C c commit -qm start
d=$(git -C "c/$n" rev-parse --absolute-git-dir)
git config -f "$d/config" filter.evil.clean "echo clean >> ${ran}; cat"
git config -f "$d/config" filter.evil.smudge "echo smudge >> ${ran}; cat"
git config -f "$d/config" diff.external "echo diff >> ${ran}; true"
sleep 1; touch "c/$n/a.txt"
`,
  )
  await execa('bash', ['make.sh', name], { cwd: root, env: { GIT_CONFIG_GLOBAL: '/dev/null' } })
  return { dir: join(root, 'c'), ran: async () => existsSync(ran) && (await readFile(ran, 'utf8')) }
}

async function globalGit(config: string) {
  process.env.GIT_CONFIG_GLOBAL = join(root, 'gitconfig')
  await writeFile(process.env.GIT_CONFIG_GLOBAL, config)
}

const head = async (dir: string) =>
  (await execa(bin('git'), ['-C', dir, 'rev-parse', 'HEAD'])).stdout

it.each([
  ['sub'],
  ['new\nline'],
  ['.away/out/x'],
  ...(process.platform === 'linux' ? [['BADBYTE']] : []),
])('snapshots a clone without running git in its submodule at %j', async (name) => {
  const { dir, ran } = await clone(name)
  expect(await snapshot(dir)).toBeDefined()
  expect(await ran()).toBe(false)
})

it("discards a step without running git in a submodule under the developer's submodule.recurse", async () => {
  const { dir, ran } = await clone('sub')
  const start = await head(dir)
  const saved = await snapshot(dir)
  if (!saved) throw new Error('no snapshot')
  await globalGit('[submodule]\n\trecurse = true\n')
  await discard(dir, start, saved)
  expect(await ran()).toBe(false)
})

it("hands off a moved submodule without diffing in it under the developer's diff.submodule", async () => {
  const { dir, ran } = await clone('sub')
  const start = await head(dir)
  const g = (cwd: string, ...args: string[]) =>
    execa(bin('git'), ['-C', cwd, '-c', 'user.name=t', '-c', 'user.email=t@t', ...args], {
      env: { GIT_CONFIG_GLOBAL: '/dev/null' },
    })
  await writeFile(join(dir, 'sub', 'a.txt'), 'b')
  await g(join(dir, 'sub'), 'commit', '-qam', 'two')
  await g(dir, 'commit', '-qam', 'move sub')
  await rm(join(root, 'ran'), { force: true })
  await globalGit('[diff]\n\tsubmodule = diff\n')
  await handOff(dir, start, join(root, 'unit'))
  expect(await ran()).toBe(false)
  expect(await readFile(join(root, 'unit', 'out', 'diff.patch'), 'utf8')).toMatch(
    /^\+Subproject commit /m,
  )
})
