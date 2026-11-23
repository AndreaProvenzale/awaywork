import { describe, expect, it } from 'vitest'
import { containerWallCheck } from '#cli/commands/doctor'
import { gatewaysOf, probeProblem } from '#core/isolation/container-wall'

const holds = [
  'direct 1.1.1.1:443 ENETUNREACH',
  'direct 172.17.0.1:4000 ENETUNREACH',
  'host 172.24.0.1:40000 ECONNREFUSED',
  'host 172.24.0.1:22 timeout',
  'dns registry.npmjs.org ESERVFAIL',
  'dns host.docker.internal ESERVFAIL',
  'anonymous HTTP/1.1 407 Proxy Authentication Required',
  'token HTTP/1.1 403 Forbidden',
].join('\n')

const reached = 'outside open\ncanary open'

describe('probeProblem', () => {
  it('passes a network with no way out and a forwarder that asks for the token', () => {
    expect(probeProblem(holds, reached, '172.17.0.1:4000')).toBeUndefined()
  })

  it('can’t tell where the default network doesn’t reach outside either', () => {
    expect(probeProblem(holds, 'canary open', 'x')).toMatch(/^can't tell.*compare with/)
  })

  it('can’t tell where the canary is out of reach, which a holding wall also looks like', () => {
    expect(probeProblem(holds, 'outside open', 'x')).toMatch(/^can't tell.*gateway check/)
    expect(probeProblem(holds, '', 'x')).toMatch(/^can't tell/)
  })

  it('names a direct connect, one that times out, a name that resolves and a forwarder that fails', () => {
    const swap = (from: string, to: string) => holds.replace(from, to)
    expect(probeProblem(swap('1.1.1.1:443 ENETUNREACH', '1.1.1.1:443 open'), reached, 'h:1')).toBe(
      "a container on the wall's network reaches 1.1.1.1:443 directly",
    )
    expect(
      probeProblem(swap('172.17.0.1:4000 ENETUNREACH', '172.17.0.1:4000 timeout'), reached, 'h:1'),
    ).toMatch(/172.17.0.1:4000 isn't refused, it times out/)
    expect(
      probeProblem(
        swap('registry.npmjs.org ESERVFAIL', 'registry.npmjs.org 104.16.1.34'),
        reached,
        'h:1',
      ),
    ).toMatch(/resolves registry.npmjs.org/)
    expect(
      probeProblem(
        swap('host 172.24.0.1:40000 ECONNREFUSED', 'host 172.24.0.1:40000 open'),
        reached,
        'h:1',
      ),
    ).toMatch(/reaches the docker host's own services at 172.24.0.1:40000/)
    expect(
      probeProblem(
        swap('anonymous HTTP/1.1 407 Proxy Authentication Required', 'anonymous HTTP/1.1 200 OK'),
        reached,
        'h:1',
      ),
    ).toMatch(/forwarder doesn't pass to awaywork's proxy at h:1/)
    expect(
      probeProblem(swap('token HTTP/1.1 403 Forbidden', 'token ECONNREFUSED'), reached, 'h:1'),
    ).toMatch(/with it: ECONNREFUSED/)
  })
})

describe('gatewaysOf', () => {
  it('takes the gateway docker names, else the first address of each subnet', () => {
    expect(
      gatewaysOf([
        { Subnet: '172.21.0.0/16', Gateway: '172.21.0.1' },
        { Subnet: '172.24.0.0/16' },
        { Subnet: 'fd00:1::/64' },
      ]),
    ).toEqual(['172.21.0.1', '172.24.0.1', 'fd00:1::1'])
  })
})

describe('doctor’s container wall check', () => {
  it('is ok where the wall comes up, and fails with the reason where it doesn’t', async () => {
    const up = await containerWallCheck(async () => ({ network: 'n', env: {} }))
    expect(up).toMatchObject({ status: 'ok', what: 'network wall' })
    const down = await containerWallCheck(async () => {
      throw new Error('the network wall isn’t up for containers (no docker)')
    })
    expect(down).toEqual({
      status: 'FAIL',
      what: 'network wall',
      detail: 'the network wall isn’t up for containers (no docker)',
    })
  })
})
