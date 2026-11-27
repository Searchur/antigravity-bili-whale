import fs from 'node:fs'
import { execFile } from 'node:child_process'
import { deserialize, serialize } from 'node:v8'

const { file, args, options } = deserialize(fs.readFileSync(0))

function reply(error, stdout = Buffer.alloc(0), stderr = Buffer.alloc(0)) {
  let failure = null
  if (error) {
    const status = typeof error.code === 'number' ? error.code : null
    let code = status === null ? error.code : undefined
    if (code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') code = 'ENOBUFS'
    else if (error.killed && error.signal) code = 'ETIMEDOUT'
    failure = { code, status, signal: error.signal ?? null, message: String(error.message).slice(0, 1000) }
  }
  process.stdout.write(serialize({ error: failure, stdout, stderr }))
}

try {
  const child = execFile(file, args, { ...options, windowsHide: true, encoding: 'buffer' }, reply)
  child.stdin?.end()
} catch (error) {
  reply(error)
}
