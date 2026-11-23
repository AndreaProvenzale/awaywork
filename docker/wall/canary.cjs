// Listens at argv `port` on the docker host's own network, to see whether a container of the wall's network reaches the host's services.
const s = require('node:net')
  .createServer((c) => c.end())
  .listen(Number(process.argv[1]), '0.0.0.0', () => console.log('ready'))
s.on('error', () => process.exit(1))
setTimeout(() => process.exit(0), 120000)
