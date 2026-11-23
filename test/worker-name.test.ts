import { expect, it, vi } from 'vitest'
import { workerNamed } from '#core/isolation/sudo'
import { MAX_USER, workerFor } from '#core/isolation/user'

vi.mock('#config/paths', async (original) => ({
  ...(await original<typeof import('#config/paths')>()),
  profile: { name: 'a-profile-name-over-twenty-three' },
}))

it('names the worker user after the profile, always awaywork on a hosted runner and in the image', () => {
  expect(workerNamed('default')).toBe('awaywork')
  expect(workerNamed('work')).toBe('awaywork-work')
  expect(workerNamed('work', { RUNNER_ENVIRONMENT: 'github-hosted' })).toBe('awaywork')
  expect(workerNamed('work', { AWAYWORK_IMAGE: '1' })).toBe('awaywork')
})

it("fits Linux's 32 characters up to a 23-character profile name", () => {
  expect(workerNamed('x'.repeat(23))).toHaveLength(MAX_USER)
  expect(workerNamed('x'.repeat(24))).toHaveLength(MAX_USER + 1)
})

it("refuses a profile whose worker user is over Linux's 32 characters", async () => {
  await expect(workerFor('user', {})).rejects.toThrow(
    'awaywork-a-profile-name-over-twenty-three is over 32 characters',
  )
})
