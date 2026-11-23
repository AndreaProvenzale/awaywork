// Pipes every connection on argv `port` to awaywork's proxy at argv `host hostPort`: the one way out of the internal network.
const net = require('node:net')
const [port, host, hostPort] = process.argv.slice(1)
net
  .createServer((from) => {
    const to = net.connect(Number(hostPort), host)
    const end = () => {
      from.destroy()
      to.destroy()
    }
    for (const s of [from, to]) {
      s.on('error', end)
      s.on('close', end)
    }
    from.pipe(to)
    to.pipe(from)
  })
  .listen(Number(port), '0.0.0.0')
