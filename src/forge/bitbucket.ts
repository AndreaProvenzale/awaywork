import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Config } from '../config/schema.js'
import { isOurs } from '../core/footer.js'
import type { Forge, Item, PrRef } from '../core/types.js'
import { type Exec, exec } from './gh.js'
import { draftText, linksItem } from './pr.js'
import { pushHead } from './push.js'

type Side = { branch: { name: string }; repository: { full_name: string } }
type Pr = {
  id: number
  title: string
  description: string | null
  state: string
  source: Side
  destination: Side
  links: { html: { href: string } }
}

const STATES = ['OPEN', 'MERGED', 'DECLINED', 'SUPERSEDED']
/** Bitbucket's largest page of PRs. */
const PAGE = 50

/** twg's JSON; under an agent `-o json` alone prints a YAML summary. */
export async function twg<T>(run: Exec, args: string[]): Promise<T> {
  const out = await run('twg', [...args, '-o', 'json', '--output-summary', 'none']).catch(
    (e: unknown) => {
      throw new Error(`twg ${args.slice(0, 3).join(' ')}: ${twgError(e)}`)
    },
  )
  return JSON.parse(out)
}

/** twg's own message: JSON on stdout or stderr, depending on the command, or plain text for a bad option. */
function twgError(e: unknown): string {
  const { stdout = '', stderr = '' } = e as { stdout?: string; stderr?: string }
  for (const text of [stderr, stdout]) {
    const message = parseJson(text)?.error?.message
    if (typeof message === 'string') return message
  }
  return stderr.trim().split('\n').at(-1) || (e instanceof Error ? e.message : String(e))
}

function parseJson(text: string): { error?: { message?: unknown } } | undefined {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

/** Every page: without `--page`, twg returns the first `--limit` and says nothing of the rest. */
async function pages<T>(run: Exec, args: string[]): Promise<T[]> {
  const all: T[] = []
  for (let page = 1; ; page++) {
    const { values, hasNextPage } = await twg<{ values: T[]; hasNextPage: boolean }>(run, [
      ...args,
      '-n',
      String(PAGE),
      '--page',
      String(page),
    ])
    all.push(...values)
    if (!hasNextPage) return all
  }
}

/** The workspaces `sources.bitbucket.repos` names, each once. */
export const bitbucketWorkspaces = (config: Config): string[] => {
  const repos = (config.sources.bitbucket as { repos?: string[] } | undefined)?.repos ?? []
  return [...new Set(repos.map((repo) => repo.split('/')[0] ?? ''))]
}

export const bitbucketRemote = (repo: string) => `git@bitbucket.org:${repo}.git`

/** Git goes over SSH with your own keys; twg's login reads and opens PRs. */
export function bitbucketForge(workspaces: string[], run: Exec = exec): Forge {
  let myPrs: Promise<Pr[]> | undefined

  const forge: Forge = {
    async clone(repo, branch, dir, fork) {
      if (fork)
        throw new Error(
          `#${fork.number} on ${repo} is from a fork, which Bitbucket has no pull ref for`,
        )
      const pick = branch ? ['--branch', branch] : []
      // An origin rewritten to a local path would hardlink its objects, and the chown hand them to the worker.
      await run('git', ['clone', '--no-local', ...pick, bitbucketRemote(repo), dir])
    },

    /** My open PRs in the configured workspaces, as `linksItem` matches them. */
    async prsFor(item: Item): Promise<PrRef[]> {
      myPrs ??= Promise.all(
        workspaces.map((w) => pages<Pr>(run, ['bb', 'prs', 'query', '--scope', 'me', '-w', w])),
      ).then((prs) => prs.flat())
      const links = linksItem(item)
      return (await myPrs)
        .filter((pr) =>
          links({ branch: pr.source.branch.name, title: pr.title, body: pr.description ?? '' }),
        )
        .map((pr) => ({
          repo: pr.destination.repository.full_name,
          number: pr.id,
          url: pr.links.html.href,
          branch: pr.source.branch.name,
          ours: isOurs(pr.description),
          mine: true,
          trusted: true,
          fork: pr.source.repository.full_name !== pr.destination.repository.full_name,
        }))
    },

    async branchExists(repo, name) {
      const ref = `refs/heads/${name}`
      const out = await run('git', ['ls-remote', bitbucketRemote(repo), ref])
      return out.split('\n').some((line) => line.split('\t')[1] === ref)
    },

    /** One query per state: `--source` with several returns none. */
    async prsOn(repo, branch) {
      const query = ['bb', 'prs', 'query', '-r', repo, '--source', branch, '--state']
      const prs = await Promise.all(STATES.map((s) => pages<Pr>(run, [...query, s])))
      return prs
        .flat()
        .filter((pr) => pr.source.repository.full_name === repo)
        .map((pr) => ({
          url: pr.links.html.href,
          body: pr.description ?? '',
          merged: pr.state === 'MERGED',
        }))
    },

    async tipMessage(repo, branch) {
      const args = ['bb', 'commit', 'query', '-r', repo, '--branch', branch, '-n', '1']
      const [tip] = await twg<{ message?: string }[]>(run, args)
      return tip?.message ?? ''
    },

    async push(dir, branch, { repo }) {
      if (await forge.branchExists(repo, branch))
        throw new Error(`refusing to push ${branch}: it already exists on ${repo}`)
      await pushHead(run, [], bitbucketRemote(repo), dir, repo, branch)
    },

    async fastForward() {
      return "Bitbucket can't push onto a PR: twg reads neither branch restrictions nor auto-merge"
    },

    async draftPr(repo, head, base, bodyFile, runId, items) {
      const { title, body } = await draftText(bodyFile, head, runId, items)
      const dir = await mkdtemp(join(tmpdir(), 'awaywork-pr-'))
      try {
        const file = join(dir, 'description.md')
        await writeFile(file, body)
        const into = base ? ['--dest', base] : []
        const args = ['bb', 'prs', 'create', '-r', repo, '--draft', '--source', head, ...into]
        const pr = await twg<Pr>(run, [...args, '--title', title, '--description-file', file])
        return pr.links.html.href
      } finally {
        await rm(dir, { recursive: true, force: true })
      }
    },

    /** Bitbucket has no stacked PRs; the upper PR's base is already the lower one's branch. */
    async stack() {},
  }
  return forge
}
