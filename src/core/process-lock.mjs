import net from 'node:net'
import crypto from 'node:crypto'
import path from 'node:path'

const sleep = ms => new Promise(r => setTimeout(r, ms))

export async function acquireProcessLock(file, { retries = 0, delayMs = 50 } = {}) {
  const canonical = path.resolve(file)
  const hash = crypto.createHash('sha256').update(process.platform === 'win32' ? canonical.toLowerCase() : canonical).digest('hex')
  const address = process.platform === 'win32'
    ? { path: '\\\\.\\pipe\\bili-whale-' + hash }
    : { host: '127.0.0.1', port: 49152 + parseInt(hash.slice(0, 8), 16) % 16384, exclusive: true }

  for (let attempt = 0; attempt <= retries; attempt++) {
    const server = net.createServer(socket => socket.destroy())
    try {
      await new Promise((resolve, reject) => {
        server.once('error', reject)
        server.listen(address, resolve)
      })
      return () => new Promise((resolve, reject) => server.close(e => e ? reject(e) : resolve()))
    } catch (e) {
      try { server.close() } catch {}
      if (attempt < retries && ['EADDRINUSE', 'EACCES'].includes(e?.code)) {
        await sleep(delayMs)
        continue
      }
      throw Error('资源锁不可用（可能有另一个进程正在访问）：' + e.code)
    }
  }
}
