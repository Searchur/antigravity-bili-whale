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

export function initialLifeState() {
  return {
    version: 1,
    revision: 0,
    events: [],
    threads: {},
    pending: {},
    memories: [],
    proposals: [],
    drafts: [],
    agenda: [],
    leases: [],
    archives: [],
    settings: {},
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

/**
 * Owns checkpoint authority and compatibility-projection reads.
 * Validation remains injected so this module does not own subsystem schemas.
 */
export function createLifePersistence({ account, owner, file, checkpointFile, validate, digest }) {
  function checkpoint() {
    const committed = JSON.parse(fs.readFileSync(checkpointFile, 'utf8'))
    if (
      committed.schema !== 1 ||
      committed.account !== account ||
      committed.owner !== owner ||
      committed.digest !== digest(committed.state)
    ) {
      throw Error('检查点身份、版本或校验失败')
    }
    return validate(committed.state)
  }

  function read() {
    if (!String(account).trim() || !String(owner).trim()) return initialLifeState()
    try {
      const projection = JSON.parse(fs.readFileSync(file, 'utf8'))
      validate(projection)
      if (fs.existsSync(checkpointFile)) {
        const committed = checkpoint()
        if (committed.revision < projection.revision) throw Error('投影超前于检查点')
        return committed
      }
      if (projection.settings.checkpointSchema === 1) {
        throw Error('权威检查点缺失，不能退回旧投影')
      }
      return projection
    } catch (error) {
      if (error.code === 'ENOENT') {
        if (fs.existsSync(checkpointFile)) return checkpoint()
        return initialLifeState()
      }
      throw Error('长期状态损坏，已停止相关写操作：' + file + '；' + error.message)
    }
  }

  return { checkpoint, read }
}
