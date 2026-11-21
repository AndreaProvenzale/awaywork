import type { Config } from '#config/schema'
import { maskSecrets } from '#worker/process/command'
import { type Exec, exec, onHost } from './gh'

/** A `trust` entry naming a GitHub team: `org/slug`. */
export const isTeam = (entry: string) => entry.includes('/')

/** The team's active members as lowercase logins, child teams' included, or why it can't be read. */
export const teamMembers = (run: Exec, team: string): Promise<string[] | { why: string }> => {
  const [org = '', slug = ''] = team.split('/')
  return run('gh', [
    'api',
    `orgs/${org}/teams/${slug}/members?per_page=100`,
    '--paginate',
    '--jq',
    '.[].login',
  ]).then(
    (out) => out.split('\n').flatMap((login) => (login ? [login.toLowerCase()] : [])),
    (e: Error & { stderr?: unknown }) => ({ why: whyUnreadable(team, e) }),
  )
}

/** A 404 is a hidden, missing or mistyped team alike; anything else says what failed. */
const whyUnreadable = (team: string, e: Error & { stderr?: unknown }) => {
  if (/HTTP 404/.test(e.message)) return `can't read ${team}, or it doesn't exist`
  const stderr = typeof e.stderr === 'string' ? e.stderr : ''
  const line = stderr.split('\n').findLast((l) => l.trim()) ?? e.message.split('\n')[0] ?? ''
  return `couldn't read ${team}: ${maskSecrets(line.trim(), ['GH_TOKEN', 'GITHUB_TOKEN'], process.env)}`
}

/** The teams the top level and the repo keys name. */
export const teamsIn = (config: Pick<Config, 'trust' | 'repos'>) => [
  ...new Set(
    [config.trust, ...Object.values(config.repos).map((r) => r.trust)]
      .flat()
      .filter(isTeam)
      .map((team) => team.toLowerCase()),
  ),
]

/**
 * The config with each team in a `trust` list replaced by its members, read once per team;
 * a team that can't be read trusts nobody and is logged once. Planning, the sources and
 * the thread host then compare logins only.
 */
export async function resolveTeams(
  config: Config,
  log: (line: string) => void,
  base: Exec = exec,
): Promise<Config> {
  const teams = config.forge.id === 'bitbucket' ? [] : teamsIn(config)
  if (!teams.length) return config
  const run = onHost(base, config.forge.host)
  const members = new Map<string, string[]>()
  await Promise.all(
    teams.map(async (team) => {
      const found = await teamMembers(run, team)
      if (Array.isArray(found)) members.set(team, found)
      else log(`github: ${found.why}; it trusts nobody`)
    }),
  )
  const expand = (list: string[]) =>
    list.flatMap((entry) => (isTeam(entry) ? (members.get(entry.toLowerCase()) ?? []) : [entry]))
  const github = config.sources.github as { trust?: Record<string, string[]> } | undefined
  return {
    ...config,
    trust: expand(config.trust),
    repos: Object.fromEntries(
      Object.entries(config.repos).map(([repo, r]) => [repo, { ...r, trust: expand(r.trust) }]),
    ),
    sources: {
      ...config.sources,
      ...(github?.trust && {
        github: {
          ...github,
          trust: Object.fromEntries(
            Object.entries(github.trust).map(([repo, list]) => [repo, expand(list)]),
          ),
        },
      }),
    },
  }
}
