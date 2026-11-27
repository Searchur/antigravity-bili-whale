/**
 * 原子 JSON 写入与 Windows 文件句柄占用重试重命名工具。
 */
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'

const id = () => crypto.randomUUID()
const RETRYABLE_RENAME = new Set(['EPERM', 'EBUSY', 'EACCES'])
const SLEEP_BUF = new Int32Array(new SharedArrayBuffer(4))

function sleepSync(ms) {
  try { Atomics.wait(SLEEP_BUF, 0, 0, ms) } catch {}
}

export function renameWithRetry(src, dest, { attempts = 8, baseDelayMs = 25 } = {}) {
  for (let i = 0; i < attempts; i++) {
    try {
      fs.renameSync(src, dest)
      return
    } catch (err) {
      if (!RETRYABLE_RENAME.has(err?.code) || i === attempts - 1) throw err
      sleepSync(baseDelayMs * (i + 1))
    }
  }
}

export function atomicWriteJson(file, value, { pretty = false, mode = 0o600 } = {}) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const tmp = file + '.' + id() + '.tmp'
  try {
    const fd = fs.openSync(tmp, 'w', mode)
    try {
      fs.writeFileSync(fd, (pretty ? JSON.stringify(value, null, 2) : JSON.stringify(value)) + '\n')
      fs.fsyncSync(fd)
    } finally {
      fs.closeSync(fd)
    }
    renameWithRetry(tmp, file)
  } finally {
    try { fs.rmSync(tmp, { force: true }) } catch {}
  }
}
