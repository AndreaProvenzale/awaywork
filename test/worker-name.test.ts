import { expect, it, vi } from 'vitest'
import { workerFor, workerNamed } from '#core/isolation'

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

it("refuses a profile whose worker user is over Linux's 32 characters", async () => {
  await expect(workerFor('user', {})).rejects.toThrow(
    'awaywork-a-profile-name-over-twenty-three is over 32 characters',
  )
})
