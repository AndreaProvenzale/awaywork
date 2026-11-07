import { createHash } from 'node:crypto'
import { createReadStream, createWriteStream } from 'node:fs'
import { mkdir, mkdtemp, readdir, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { parse } from 'yaml'
import type { Config } from '../config/schema.js'
import { commentKind, type Pin, pinsOf } from '../core/footer.js'
import { globToRegExp } from '../core/glob.js'
import { contractName } from '../core/plan.js'
import { decisionPosts, type PinnedPost } from '../core/posts.js'
import { itemState } from '../core/queue.js'
import type { Item } from '../core/types.js'
import { runShell } from '../sources/command.js'

/** `dir` is the folder of the config file that set the command, set when the config loads. */
export type Store = NonNullable<Config['store']> & { dir?: string }

/** Files a step leaves in `.away/out/` that awaywork reads itself, or writes: never put. */
const ownFiles = [
  'status',
  'verdict',
  'questions.md',
  'summary.md',
  'pr.md',
  'push.md',
  'review.json',
  'diff.patch',
  'check.log',
  'verify.log',
]

const sha256 = (path: string): Promise<string> =>
  new Promise((resolve, reject) => {
    const hash = createHash('sha256')
    createReadStream(path)
      .on('data', (chunk) => hash.update(chunk))
      .on('end', () => resolve(hash.digest('hex')))
      .on('error', reject)
  })

/** The regular files under `dir`, by their path in it, but awaywork's own and its judges' logs. */
export async function outFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { recursive: true, withFileTypes: true }).catch(() => [])
  return entries
    .filter((e) => e.isFile())
    .map((e) => join(e.parentPath, e.name).slice(dir.length + 1))
    .filter((name) => !ownFiles.includes(name) && !/^judge-.*\.log$/.test(name))
    .sort()
}

/** What a put says a file is: `plan`, `contract`, `report`, else its name. */
export type Kind = 'plan' | 'contract' | 'report' | (string & {})

/**
 * Puts each file of `dir` named in `files` in the store, the item and unit it's for alongside, and pins it by the URL the
 * store printed and its sha256; a put that fails pins nothing for its file, its line in `failed`.
 */
export async function putFiles(
  store: Store,
  env: NodeJS.ProcessEnv,
  dir: string,
  files: { name: string; kind: Kind }[],
  at: { item: string; unit: string },
): Promise<{ pins: Pin[]; failed: string[] }> {
  const pins: Pin[] = []
  const failed: string[] = []
  for (const { name, kind } of files) {
    const path = join(dir, name)
    try {
      const op = { op: 'put', item: at.item, unit: at.unit, path, kind }
      const { stdout } = await runShell(store.command, store.dir, env, JSON.stringify(op))
      const url = (JSON.parse(stdout) as { url?: unknown }).url
      if (typeof url !== 'string' || !/^\S+$/.test(url))
        throw new Error(`printed no {"url": "…"} but ${stdout.slice(0, 200)}`)
      pins.push({ name, url, sha256: await sha256(path) })
    } catch (e) {
      failed.push(`${name} not stored: ${(e as Error).message.split('\n')[0]}`)
    }
  }
  return { pins, failed }
}

/** Gets the file at `url` into `to`, through the store's command, or with a plain HTTP GET when it has no get. */
async function getFile(store: Store, env: NodeJS.ProcessEnv, url: string, to: string) {
  await mkdir(dirname(to), { recursive: true })
  if (store.get) {
    await runShell(store.command, store.dir, env, JSON.stringify({ op: 'get', url }), to)
    return
  }
  const res = await fetch(url)
  if (!res.ok || !res.body) throw new Error(`GET ${url}: ${res.status} ${res.statusText}`)
  await pipeline(Readable.fromWeb(res.body as never), createWriteStream(to))
}

/** A name a file can have under a folder: relative, with no `.`, `..` or empty part. */
const inside = (name: string) => name.split('/').every((p) => p && p !== '.' && p !== '..')

/** What came back of a post's pins: the files that match their hash, those edited since, those the cap left out. */
export interface ReadBack {
  read: string[]
  stale: string[]
  over: string[]
}

/**
 * Gets the pins the store's `read.files` takes, and those `always` names, into `dir`, until they'd pass `budget.left` bytes;
 * one whose sha256 isn't its pin's is `stale`. Throws when a get fails.
 */
async function readPins(
  store: Store,
  env: NodeJS.ProcessEnv,
  pins: Pin[],
  dir: string,
  budget: { left: number },
  always: string[] = [],
): Promise<ReadBack> {
  const globs = store.read.files.map(globToRegExp)
  const wanted = (name: string) =>
    always.includes(name) ||
    !globs.length ||
    globs.some((g) => g.test(name) || g.test(basename(name)))
  const back: ReadBack = { read: [], stale: [], over: [] }
  for (const pin of pins) {
    if (!inside(pin.name) || !wanted(pin.name)) continue
    if (budget.left <= 0) {
      back.over.push(pin.name)
      continue
    }
    const to = join(dir, pin.name)
    try {
      await getFile(store, env, pin.url, to)
    } catch (e) {
      throw new Error(
        `couldn't read ${pin.name} from the store: ${(e as Error).message.split('\n')[0]}`,
      )
    }
    const { size } = await stat(to)
    if (size > budget.left && !always.includes(pin.name)) {
      await rm(to)
      back.over.push(pin.name)
      continue
    }
    budget.left -= size
    back[(await sha256(to)) === pin.sha256 ? 'read' : 'stale'].push(pin.name)
  }
  return back
}

const bytes = (store: Store) => store.read.max_mb * 1_000_000

/**
 * Reads back the pins of the posts that decide a rule on each open item of yours, and every lean plan's `plan.yml` and
 * contract: a file whose hash no longer matches makes the post stale, a get that fails leaves why on it.
 */
export async function checkPins(items: Item[], store: Store, env: NodeJS.ProcessEnv) {
  for (const item of items) {
    if (!item.mine || itemState(item) !== 'open') continue
    const deciding = decisionPosts(item)
    const plans = item.comments.filter((c) => commentKind(c) === 'plan' && !deciding.includes(c))
    for (const post of [...deciding, ...plans]) {
      const pins = pinsOf(post)
      if (!pins.length) continue
      const tmp = await mkdtemp(join(tmpdir(), 'awaywork-pins-'))
      try {
        const plan = commentKind(post) === 'plan'
        const budget = { left: bytes(store) }
        const own = plan ? pins.filter((p) => p.name === 'plan.yml') : []
        const first = await readPins(store, env, own, tmp, budget, ['plan.yml'])
        const yaml = first.read.length ? await readFile(join(tmp, 'plan.yml'), 'utf8') : ''
        const contract = yaml && contractIn(yaml)
        const files: Record<string, string> = yaml ? { 'plan.yml': yaml } : {}
        // An older plan only says which tasks it named.
        const rest = deciding.includes(post) ? pins.filter((p) => p.name !== 'plan.yml') : []
        const back = await readPins(store, env, rest, tmp, budget, contract ? [contract] : [])
        if (contract && back.read.includes(contract))
          files[contract] = await readFile(join(tmp, contract), 'utf8')
        const stale = [...first.stale, ...back.stale][0]
        post.pinned = { files, ...(stale && { stale }) }
      } catch (e) {
        post.pinned = { files: {}, failed: (e as Error).message }
      } finally {
        await rm(tmp, { recursive: true, force: true })
      }
    }
  }
}

/** The contract's name a `plan.yml` names, if any. */
function contractIn(yaml: string): string | undefined {
  try {
    const path = (parse(yaml) as { contract?: unknown } | null)?.contract
    return typeof path === 'string' ? contractName(path) : undefined
  } catch {
    return undefined
  }
}

/**
 * Reads back the files of a unit's `posts` into `dir`, a folder per post, within the store's cap; returns a line per file
 * edited since it was pinned, and for those left out, links still. Throws when a get fails.
 */
export async function readBack(
  store: Store,
  env: NodeJS.ProcessEnv,
  posts: PinnedPost[],
  dir: string,
): Promise<string[]> {
  const budget = { left: bytes(store) }
  const notes: string[] = []
  for (const post of posts) {
    const back = await readPins(store, env, post.pins, join(dir, post.name), budget)
    for (const name of back.stale)
      notes.push(`${name} of ${post.what} changed in the store since awaywork pinned it`)
    if (back.over.length)
      notes.push(
        `over the store's read.max_mb, left as links: ${back.over.join(', ')} of ${post.what}`,
      )
  }
  return notes
}
