// Prints what a container on the wall's network reaches; argv: the forwarder's alias and port, the token, then targets, those starting with host= being the docker host's.
const net = require('node:net')
const dns = require('node:dns')
const [alias, port, token, ...targets] = process.argv.slice(1)

const tcp = (host, port) =>
  new Promise((done) => {
    const s = net.connect({ host, port: Number(port), timeout: 3000 })
    s.on('connect', () => {
      s.destroy()
      done('open')
    })
    s.on('timeout', () => {
      s.destroy()
      done('timeout')
    })
    s.on('error', (e) => done(e.code || 'error'))
  })

const resolver = new dns.promises.Resolver({ timeout: 1500, tries: 1 })
const lookup = (name) =>
  resolver.resolve4(name).then(
    (a) => a.join(','),
    (e) => e.code,
  )

const via = (auth) =>
  new Promise((done) => {
    const s = net.connect(Number(port), alias)
    const credentials = Buffer.from(`awaywork:${token}`).toString('base64')
    let seen = ''
    s.setTimeout(5000, () => {
      s.destroy()
      done('timeout')
    })
    s.on('connect', () =>
      s.write(
        `CONNECT awaywork.invalid:443 HTTP/1.1\r\nHost: x\r\n${auth ? `Proxy-Authorization: Basic ${credentials}\r\n` : ''}\r\n`,
      ),
    )
    s.on('data', (b) => {
      seen += b
      if (seen.includes('\r\n')) {
        s.destroy()
        done(seen.split('\r\n')[0])
      }
    })
    s.on('error', (e) => done(e.code || 'error'))
  })

;(async () => {
  const seen = await Promise.all([
    ...targets.map(async (t) => {
      const target = t.replace(/^host=/, '')
      const at = target.lastIndexOf(':')
      return [
        t === target ? 'direct' : 'host',
        target,
        await tcp(target.slice(0, at), target.slice(at + 1)),
      ]
    }),
    via(false).then((answer) => ['anonymous', answer]),
    via(true).then((answer) => ['token', answer]),
  ])
  for (const name of ['registry.npmjs.org', 'host.docker.internal'])
    seen.push(['dns', name, await lookup(name)])
  for (const line of seen) console.log(line.join(' '))
})()
