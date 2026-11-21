import { afterEach, expect, it, vi } from 'vitest'

afterEach(() => {
  vi.doUnmock('#config/paths')
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
  vi.resetModules()
})

async function doctorOf(name: string) {
  vi.stubEnv('RUNNER_ENVIRONMENT', '')
  vi.stubEnv('AWAYWORK_IMAGE', '')
  vi.resetModules()
  vi.doMock('#config/paths', async (original) => ({
    ...(await original<typeof import('#config/paths')>()),
    profile: { name },
  }))
  return import('#cli/commands/doctor')
}

it("prints a named profile's worker user in its setup", async () => {
  const { workerFailure } = await doctorOf('work')
  const { detail } = workerFailure('no sudo', true)
  expect(detail).toContain('--user-group --shell /usr/sbin/nologin awaywork-work\n')
  expect(detail).toContain('echo awaywork-work | sudo tee -a /etc/cron.deny /etc/at.deny')
  expect(detail).toContain('sudo visudo -f /etc/sudoers.d/awaywork-work')
  expect(detail).toContain('ALL=(awaywork-work) NOPASSWD:SETENV: ALL')
})

it('offers no setup for a profile whose worker user is over 32 characters', async () => {
  vi.spyOn(process, 'platform', 'get').mockReturnValue('linux')
  const { isolationChecks } = await doctorOf('x'.repeat(24))
  const [check] = await isolationChecks('user', {})
  expect(check?.detail).toContain('is over 32 characters')
  expect(check?.detail).not.toContain('useradd')
})
