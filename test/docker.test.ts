import { readFile } from 'node:fs/promises'
import { afterEach, expect, it, vi } from 'vitest'
import { packageVersion } from '../src/config/paths.js'
import { sudoersLines } from '../src/core/launch.js'

const dockerfile = await readFile(new URL('../docker/Dockerfile', import.meta.url), 'utf8')

afterEach(() => vi.restoreAllMocks())

it("gives the image's developer user the sudoers lines isolation: user asks for", () => {
  const uid = dockerfile.match(/useradd --uid (\d+) --gid away /)?.[1]
  const gid = dockerfile.match(/groupadd --gid (\d+) away/)?.[1]
  vi.spyOn(process, 'getuid').mockReturnValue(Number(uid))
  vi.spyOn(process, 'getgid').mockReturnValue(Number(gid))
  const sudoers = dockerfile.match(/<<"EOF" \/etc\/sudoers\.d\/awaywork\n([\s\S]*?)\nEOF\n/)?.[1]
  expect(sudoers).toBe(sudoersLines('away').join('\n'))
})

it('pins the awaywork version it ships in', () => {
  expect(dockerfile).toContain(`ARG AWAYWORK_VERSION=${packageVersion}\n`)
})
