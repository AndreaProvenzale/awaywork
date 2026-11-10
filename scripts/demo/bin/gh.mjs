#!/usr/bin/env node
// Stands in for `gh` in the demo, so nothing reaches GitHub: answers from the tests' recorded acme fixtures, plus the draft PRs runs opened, and fails the rest.
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs'

const home = process.env.HOME
const fixture = (name) => readFileSync(`${home}/fixtures/gh/${name}`, 'utf8')
const args = process.argv.slice(2)
const line = args.join(' ')
const flag = (name) => args[args.indexOf(name) + 1]

const prsFile = `${home}/.gh/prs.json`
const opened = existsSync(prsFile) ? JSON.parse(readFileSync(prsFile, 'utf8')) : []

const openPr = () => {
  const repo = flag('-R')
  const pr = {
    number: 14 + opened.length,
    repo,
    title: flag('--title'),
    body: flag('--body'),
    head: flag('--head'),
    base: args.includes('--base') ? flag('--base') : 'main',
    at: new Date().toISOString(),
  }
  writeFileSync(prsFile, JSON.stringify([...opened, pr]))
  return `https://github.com/${repo}/pull/${pr.number}\n`
}

const prNode = (pr) => ({
  __typename: 'PullRequest',
  id: `PR_demo_${pr.number}`,
  number: pr.number,
  title: pr.title,
  body: pr.body,
  url: `https://github.com/${pr.repo}/pull/${pr.number}`,
  state: 'OPEN',
  createdAt: pr.at,
  updatedAt: pr.at,
  repository: { nameWithOwner: pr.repo },
  author: { login: 'dev' },
  authorAssociation: 'OWNER',
  assignees: { nodes: [] },
  labels: { nodes: [] },
  comments: { nodes: [] },
  isDraft: true,
  isCrossRepository: false,
  headRefName: pr.head,
  headRefOid: `f00d${pr.number}`,
  baseRefName: pr.base,
  baseRef: { target: { oid: 'def5678' } },
  mergeable: 'MERGEABLE',
  viewerDidAuthor: true,
  editor: null,
  additions: 9,
  deletions: 0,
  files: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] },
  reviewRequests: { nodes: [] },
  reviewThreads: { nodes: [] },
  commits: { nodes: [{ commit: { statusCheckRollup: { state: 'SUCCESS' } } }] },
})

const authored = () => {
  const recorded = JSON.parse(fixture('search-authored.json'))
  recorded.data.search.nodes.push(...opened.map(prNode))
  recorded.data.search.issueCount = recorded.data.search.nodes.length
  return JSON.stringify(recorded)
}

const routes = [
  [/author:@me/, authored],
  [/review-requested:@me/, () => fixture('search-review-requested.json')],
  [/assignee:@me/, () => fixture('search-assigned.json')],
  [/nodes\(ids:/, () => fixture('threads.json')],
  [/compare\(headRef: "main"\)/, () => fixture('behind.json')],
  [/-F number=\d+ /, () => fixture('pr-1.json')],
  [/^pr diff /, () => fixture('pr-1.diff')],
  [/^run view .*--log-failed/, () => fixture('job-201.txt')],
  [/git\/matching-refs/, () => '[]'],
  [/^pr create /, openPr],
]
const route = routes.find(([pattern]) => pattern.test(line))
appendFileSync(`${home}/gh-calls.log`, `${route ? 'ok  ' : 'miss'} ${line.slice(0, 160)}\n`)
if (route) process.stdout.write(route[1]())
else {
  process.stderr.write('demo: no GitHub here\n')
  process.exit(1)
}
