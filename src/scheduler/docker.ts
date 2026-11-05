import { existsSync } from 'node:fs'
import { readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { dockerDir, packageVersion } from '../config/paths.js'

/** What `schedule install --with docker` writes at the repo root, from the package's `docker/`. */
export const DOCKER_FILES = ['Dockerfile', 'compose.yml', 'entrypoint.sh']

export interface Image {
  /** The awaywork version the image installs. */
  version: string
  packages: string[]
  /** Bash scripts installing the providers' CLIs that have no npm package, written for a runner's user. */
  scripts: string[]
  /** Command sources' setup scripts, run in the config's folder. */
  setup: string[]
  /** The env vars compose passes in; GH_TOKEN is required, the rest may be empty. */
  secrets: string[]
  /** The default `TZ`, the zone the windows are in. */
  timezone: string
}

/** The container's files: the templates, fit to what a config needs. */
export async function dockerFiles(image: Image): Promise<Record<string, string>> {
  const template = (file: string) => readFile(join(dockerDir, file), 'utf8')
  const scripts = image.scripts.map((s) => `${asRoot(s)}\n`).join('')
  const setup = image.setup
    .map(
      (s) =>
        `# A command source's setup, in the config's folder, without the secrets.\nRUN <<"AWAYWORK_SETUP"\n#!/usr/bin/env bash\nset -eo pipefail\ncd /home/away/.awaywork\n${s.trimEnd()}\nAWAYWORK_SETUP\n`,
    )
    .join('')
  const env = image.secrets
    .map((name) => `      ${name}: \${${name}${name === 'GH_TOKEN' ? ':?' : ':-'}}\n`)
    .join('')
  return {
    Dockerfile: (await template('Dockerfile'))
      .replace(/^ARG AWAYWORK_VERSION=.*$/m, `ARG AWAYWORK_VERSION=${image.version}`)
      .replace(/^ARG PACKAGES=.*$/m, `ARG PACKAGES="${image.packages.join(' ')}"`)
      .replace(/^# Your repos' toolchains go here.*\n/m, (line) => line + scripts)
      .replace(/^COPY \.awaywork .*\n/m, (line) => line + setup),
    'compose.yml': (await template('compose.yml'))
      .replace(/^( {4}environment:\n)(?: {6}[A-Z0-9_]+: .*\n)+/m, (_, key) => key + env)
      .replace(/\$\{TZ:-UTC\}/, `\${TZ:-${image.timezone}}`),
    'entrypoint.sh': await template('entrypoint.sh'),
  }
}

/** A runner's install script as one RUN line: the build runs as root, so no sudo and nothing to chown. */
const asRoot = (script: string) =>
  `RUN ${script
    .trim()
    .split('\n')
    .map((line) => line.replace(/^sudo /, '').replace(' -o "$USER"', ''))
    .join(' \\\n  && ')}`

const versionIn = (dockerfile: string) => /^ARG AWAYWORK_VERSION=(\S+)$/m.exec(dockerfile)?.[1]

/** The awaywork version the repo's Dockerfile builds; undefined when it isn't awaywork's. */
export const imageVersion = async (root: string) => {
  const file = join(root, 'Dockerfile')
  return existsSync(file) ? versionIn(await readFile(file, 'utf8')) : undefined
}

/** Deletes the container's files under a repo root; false when its Dockerfile isn't awaywork's. */
export async function removeDocker(root: string): Promise<boolean> {
  if (!(await imageVersion(root))) return false
  for (const file of DOCKER_FILES) await rm(join(root, file), { force: true })
  return true
}

/** Warns when the repo's Dockerfile builds another awaywork than this one. */
export async function staleDocker(root: string): Promise<string | undefined> {
  const version = await imageVersion(root)
  if (!version || version === packageVersion) return
  return `Dockerfile builds awaywork ${version}, this is ${packageVersion}; run \`awaywork schedule install --with docker\` again to match`
}
