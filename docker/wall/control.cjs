// Prints `outside open` at the first connect to a public address, trying two, twice (a network just up can miss one), then `canary open` if argv `host port` accepts: proof the canary is still listening.
const net = require('node:net')

const tcp = (host, port) =>
  new Promise((done) => {
    const s = net.connect({ host, port, timeout: 3000 })
    s.on('connect', () => {
      s.destroy()
      done(true)
    })
    s.on('timeout', () => {
      s.destroy()
      done(false)
    })
    s.on('error', () => done(false))
  })

;(async () => {
  for (const host of ['1.1.1.1', '8.8.8.8', '1.1.1.1', '8.8.8.8'])
    if (await tcp(host, 443)) {
      console.log('outside open')
      break
    }
  const [host, port] = process.argv.slice(1)
  if (host && (await tcp(host, Number(port)))) console.log('canary open')
})()
