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

it("prints a named profile's wall rules where the wall is missing, as a failure", async () => {
  const { wallCheck } = await doctorOf('work')
  const check = await wallCheck(
    'awaywork-work',
    {},
    async () => 'awaywork-work reaches api.github.com',
  )
  expect(check.status).toBe('FAIL')
  expect(check.what).toBe('network wall')
  expect(check.detail).toContain(
    'sudo iptables -I OUTPUT -m owner --uid-owner awaywork-work -o lo -p tcp --dport 53 -j REJECT',
  )
  expect(check.detail).toContain(
    'sudo ip6tables -I OUTPUT -m owner --uid-owner awaywork-work -j REJECT',
  )
})

it('tells a hosted runner to use the action, and NET_ADMIN in the image', async () => {
  const { wallCheck } = await doctorOf('default')
  const env = { RUNNER_ENVIRONMENT: 'github-hosted' }
  const hosted = await wallCheck('awaywork', env, async () => 'x')
  expect(hosted.status).toBe('FAIL')
  expect(hosted.detail).toContain('through its action')
  expect(hosted.detail).not.toContain('iptables')
  const image = await wallCheck('awaywork', { AWAYWORK_IMAGE: '1' }, async () => 'x')
  expect(image.status).toBe('FAIL')
  expect(image.detail).toContain('cap_add: [NET_ADMIN]')
})

it('is ok where the wall holds', async () => {
  const { wallCheck } = await doctorOf('default')
  expect((await wallCheck('awaywork', {}, async () => undefined)).status).toBe('ok')
})

it('fails a sandbox that can’t start where its units are refused, warns where they run behind the wall or open', async () => {
  const { sandboxCheck } = await doctorOf('default')
  const down = "bwrap can't start here (needs bubblewrap and user namespaces)"
  expect(sandboxCheck('codex', undefined, 'refused')).toEqual([
    'ok',
    'codex sandbox',
    'shell runs offline',
  ])
  const [refused, , detail] = sandboxCheck('codex', down, 'refused')
  expect(refused).toBe('FAIL')
  expect(detail).toContain("Codex's units are skipped")
  expect(sandboxCheck('codex', down, 'wall')[0]).toBe('warn')
  expect(sandboxCheck('codex', down, 'wall')[2]).toContain("through awaywork's wall")
  expect(sandboxCheck('codex', down, 'open')[2]).toContain('unsandboxed, with network access')
})
