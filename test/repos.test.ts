import { describe, expect, it } from 'vitest'
import { parseConfig } from '#config/load'
import { builtinSkills } from '#core/skills'
import { planRun } from '#plan/foreman'
import { repoListed, settingsFor } from '#plan/repos'
import { githubSource, githubThreads } from '#sources/github'
import { planLimits } from '#tasks/fanout'
import { checkPlan } from '#tasks/plan-file'
import { githubRoutes, recorded } from './fakes/gh'
import { fakeItem, githubPr } from './fakes/items'

const config = (top: string, sources = '{ github: {} }') =>
  `providers: [claude]\n${top}\nsources: ${sources}\n`
const problems = (text: string): string[] => {
  try {
    parseConfig(text)
    return []
  } catch (e) {
    return (e as { problems: string[] }).problems
  }
}

describe('repos', () => {
  it('takes a bare key as a listed repo with no settings', () => {
    const { repos } = parseConfig(config('repos:\n  acme/api:\n  acme/*: { setup: yarn }'))
    expect(repos['acme/api']).toEqual({ secrets: [], gates: {} })
    expect(repoListed(repos, 'acme/api')).toBe(true)
    expect(repoListed(repos, 'Acme/Web')).toBe(true)
    expect(repoListed(repos, 'other/api')).toBe(false)
    expect(problems(config('repos: { acme: }'))).toEqual(['repos.acme: expected owner/name'])
  })

  it('merges the keys naming a repo per setting: globs as written, then its own key', () => {
    const { repos } = parseConfig(
      config(`repos:
  acme/api: { verify: yarn lint, secrets: [NPM_TOKEN], gates: { routes: { command: ./routes.sh } } }
  "*/*": { setup: npm ci, test: npm test, gates: { deps: { changed: package.json } } }
  acme/*: { setup: yarn install, verify: yarn test, secrets: [NPM_TOKEN, SENTRY_DSN] }`),
    )
    expect(settingsFor(repos, 'acme/api')).toEqual({
      setup: 'yarn install',
      test: 'npm test',
      verify: 'yarn lint',
      secrets: ['NPM_TOKEN', 'SENTRY_DSN'],
      gates: { deps: { changed: ['package.json'] }, routes: { command: './routes.sh' } },
    })
    expect(settingsFor(repos, 'acme/web')).toMatchObject({
      setup: 'yarn install',
      verify: 'yarn test',
    })
    expect(settingsFor(repos, 'other/docs')).toMatchObject({ setup: 'npm ci', secrets: [] })
    expect(settingsFor({}, 'acme/api')).toEqual({ secrets: [], gates: {} })
  })

  it('needs an image for a repo under isolation: container, its own or a glob’s', () => {
    const container = (repos: string) => problems(config(`isolation: container\nrepos: ${repos}`))
    expect(container('{ acme/*: { image: node }, acme/api: }')).toEqual([])
    expect(container('{ acme/web: { image: node }, acme/api: }')).toEqual([
      'repos.acme/api.image: required with isolation: container: the image its units run in',
    ])
  })
})

describe('forge', () => {
  const forgeOf = (forge: string) =>
    parseConfig(config(`${forge}\nrepos: { acme/api: }`, "{ tracker: { command: 'echo []' } }"))
      .forge

  it("is github unless set, by name or as a map of GitHub's settings", () => {
    expect(forgeOf('')).toEqual({ id: 'github' })
    expect(forgeOf('forge: github')).toEqual({ id: 'github' })
    expect(forgeOf('forge: { github: }')).toEqual({ id: 'github' })
    expect(forgeOf('forge: bitbucket')).toEqual({ id: 'bitbucket' })
    expect(forgeOf('forge: { github: { host: github.acme.com, user: octocat } }')).toEqual({
      id: 'github',
      host: 'github.acme.com',
      user: 'octocat',
    })
  })

  it('refuses an unknown forge, a second forge and a bad setting', () => {
    const forge = (yaml: string) => problems(config(`forge: ${yaml}\nrepos: { acme/api: }`))
    expect(forge('gitlab')).toEqual(['forge: unknown forge "gitlab": github or bitbucket'])
    expect(forge('{ github: {}, bitbucket: {} }')).toEqual(['forge: Unrecognized key: "bitbucket"'])
    expect(forge('{ github: { host: "https://github.acme.com" } }')).toEqual([
      'forge.github.host: host only, no scheme or path',
    ])
    const forms =
      'forge: expected github or bitbucket, or github as a map of its settings, e.g. { github: { host: github.acme.com } }; bitbucket takes no settings'
    expect(forge('{ bitbucket: {} }')).toEqual([forms])
    expect(forge('{}')).toEqual([forms])
  })

  it('needs a repo listed on Bitbucket', () => {
    expect(problems(config('forge: bitbucket', "{ tracker: { command: 'echo []' } }"))).toEqual([
      'repos: forge: bitbucket works in the repos listed here: add one, e.g. acme/api or acme/*',
    ])
  })
})

describe('keys that moved', () => {
  it('refuses each with the new spelling', () => {
    const github = (keys: string) =>
      problems(config('repos: { acme/api: }', `{ github: { ${keys} } }`))
    expect(github('repos: [acme/api]')).toEqual([
      'sources.github: repos was removed: list each repo as a key of the top-level repos, e.g. repos: { acme/api: }',
    ])
    expect(github('host: github.acme.com')).toEqual([
      'sources.github: host was removed: it goes on the forge, forge: { github: { host: github.acme.com } }',
    ])
    expect(github('user: octocat')).toEqual([
      'sources.github: user was removed: it goes on the forge, forge: { github: { user: octocat } }',
    ])
    expect(github('host: github.acme.com, user: octocat')).toEqual([
      expect.stringMatching(/^sources\.github: host was removed: .*; user was removed: /),
    ])
    expect(
      problems(config('', "{ bitbucket: { repos: [acme/api] }, tracker: { command: 'echo []' } }")),
    ).toEqual([
      'sources.bitbucket: the bitbucket source was removed: write forge: bitbucket at the top level and list each repo as a key of repos',
    ])
  })

  it('needs a repo listed for the github source to read', () => {
    expect(problems(config(''))).toEqual([
      'repos: the github source reads the repos listed here: add one, e.g. acme/api or acme/*',
    ])
  })
})

describe('the allowlist', () => {
  const tracker = (repos: string, thread = '') =>
    parseConfig(
      config(
        `repos: ${repos}`,
        `{ tracker: { command: 'echo []' } }\nqueue: [{ skill: plan, deliver: plan${thread} }, { skill: implement, where: { planned: true } }]`,
      ),
    )
  const card = (repo: string) =>
    fakeItem({ source: 'tracker', key: `ENG-${repo.length}`, type: 'task', fields: { repo } })

  it("skips a custom source's item whose repo no key names, saying so", () => {
    const plan = planRun({
      config: tracker('{ acme/api: }'),
      items: [card('acme/api'), card('acme/billing')],
      allowances: {},
      skills: { builtin: builtinSkills },
    })
    expect(plan.units.map((u) => u.unit.repo)).toEqual(['acme/api'])
    expect(plan.skipped.map((s) => [s.item.key, s.kind, s.reason])).toEqual([
      [
        'ENG-12',
        'unlisted_repo',
        "acme/billing isn't in repos: awaywork works only in the repos listed there",
      ],
    ])
  })

  it('skips an item whose own repo no key names, though its linked PR is in a listed one', () => {
    const item = fakeItem({
      source: 'tracker',
      key: 'ENG-1',
      type: 'task',
      mine: true,
      linkedPrs: githubPr(1).linkedPrs,
      fields: { repo: 'other/unlisted' },
    })
    const plan = planRun({
      config: tracker('{ acme/api: }', ', thread: github'),
      items: [item],
      allowances: {},
      skills: { builtin: builtinSkills },
    })
    expect(plan.units).toEqual([])
    expect(plan.skipped.map((s) => [s.item.key, s.kind, s.reason])).toEqual([
      [
        'ENG-1',
        'unlisted_repo',
        "other/unlisted isn't in repos: awaywork works only in the repos listed there",
      ],
    ])
  })

  it('opens, comments on and closes a thread issue only in a repo a key names', async () => {
    const run = recorded([])
    const threads = githubThreads(run, undefined, { 'acme/*': {} })
    const refused = "other/unlisted isn't in repos: awaywork writes only in the repos listed there"
    const thread = { host: 'github', key: 'other/unlisted#7', url: 'https://github.com/x' }
    await expect(threads.openThread('other/unlisted', fakeItem())).rejects.toThrow(refused)
    await expect(threads.threadComment(thread, 'hi')).rejects.toThrow(refused)
    await expect(threads.closeThread(thread, 'done')).rejects.toThrow(refused)
    expect(run.calls).toEqual([])
  })

  it('refuses a repo the config names outside repos: a routine’s, a tracker’s repo_map', () => {
    const unlisted = (repo: string) =>
      `${repo} isn't in repos: awaywork works only in the repos listed there, so add it as a key`
    const routine = (repo: string) =>
      problems(
        config(
          'repos: { acme/*: }',
          `{ routines: { nightly: { at: "03:00", repo: ${repo}, title: T } } }`,
        ),
      )
    expect(routine('acme/api')).toEqual([])
    expect(routine('other/x')).toEqual([`sources.routines.nightly.repo: ${unlisted('other/x')}`])
    const jira = (top: string) =>
      problems(
        config(
          top,
          '{ jira: { site: acme.atlassian.net, email: a@b.c, repo_map: { ENG: acme/api } } }',
        ),
      )
    expect(jira('repos: { acme/api: }')).toEqual([])
    expect(jira('')).toEqual([`sources.jira.repo_map.ENG: ${unlisted('acme/api')}`])
    const pattern = (repo: string) =>
      `expected one repo like acme/api, not the pattern ${repo}: a * goes only in a key of repos`
    expect(routine('acme/*')).toEqual([`sources.routines.nightly.repo: ${pattern('acme/*')}`])
    expect(
      problems(
        config(
          'repos: { acme/*: }',
          '{ jira: { site: acme.atlassian.net, email: a@b.c, repo_map: { ENG: acme/* } } }',
        ),
      ),
    ).toContain(`sources.jira.repo_map.ENG: ${pattern('acme/*')}`)
    // What init --yes --source jira writes: no repo_map, no repos.
    expect(problems(config('', '{ jira: { site: acme.atlassian.net, email: a@b.c } }'))).toEqual([])
  })

  it('lets a plan task name only a repo a key names', () => {
    const globbed = tracker('{ acme/*: , other/docs: }')
    const limits = planLimits(globbed, globbed.queue ?? [], card('acme/api'), {
      builtin: builtinSkills,
    })
    expect(limits.repos).toEqual(['acme/*', 'other/docs'])
    const problem = (repo: string) => {
      const checked = checkPlan(`tasks:\n  - { id: a, title: A, repo: ${repo} }\n`, limits)
      return 'problem' in checked ? checked.problem : undefined
    }
    expect(problem('acme/web')).toBeUndefined()
    expect(problem('other/docs')).toBeUndefined()
    expect(problem('other/api')).toBe(
      "task a: repo other/api isn't the card's (acme/api) or one the config names",
    )
  })
})

describe('the github source', () => {
  it('reads the repos the config lists, on the forge’s host', async () => {
    const scoped = (top: string) => parseConfig(config(top)).sources.github as { repos: string[] }
    expect(scoped('forge: { github: { host: github.acme.com } }\nrepos: { acme/web: }')).toEqual({
      repos: ['acme/web'],
      host: 'github.acme.com',
    })
    const items = (top: string) =>
      githubSource(recorded(githubRoutes())).items(scoped(top), { env: {}, log: () => {} })
    expect((await items('repos: { acme/web: }')).map((i) => i.key)).toEqual([
      'acme/web#3',
      'acme/web#6',
    ])
    expect(await items('repos: { acme/*: , other/docs: }')).toHaveLength(5)
  })
})
