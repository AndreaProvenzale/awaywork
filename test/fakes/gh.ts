import { readFileSync } from 'node:fs'
import type { Exec } from '../../src/forge/gh.js'

export const fixture = (name: string) =>
  readFileSync(new URL(`../fixtures/gh/${name}`, import.meta.url), 'utf8')

/** Replays recorded output: the first route whose pattern matches the command line answers. */
export function recorded(routes: [RegExp, string][]): Exec & { calls: string[][] } {
  const calls: string[][] = []
  const run = async (cmd: string, args: string[]) => {
    calls.push([cmd, ...args])
    const line = [cmd, ...args].join(' ')
    const route = routes.find(([pattern]) => pattern.test(line))
    if (!route) throw new Error(`no recorded output for: ${line.slice(0, 120)}`)
    return route[1]
  }
  return Object.assign(run, { calls })
}

export const githubRoutes = (): [RegExp, string][] => [
  [/q=is:pr is:open archived:false author:@me/, fixture('search-authored.json')],
  [/q=is:pr is:open archived:false review-requested:@me/, fixture('search-review-requested.json')],
  [/q=is:issue is:open archived:false assignee:@me/, fixture('search-assigned.json')],
  [/owner=acme -f name=api -F number=1 /, fixture('pr-1.json')],
  [/^gh pr diff 1 -R acme\/api$/, fixture('pr-1.diff')],
  [/^gh run view -R acme\/api --job 201 --log-failed$/, fixture('job-201.log')],
]
