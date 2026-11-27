/**
 * 长期状态检查点持久化与兼容投影读取器。
 */
import fs from 'node:fs'
import { atomicWriteJson, renameWithRetry } from '../core/atomic-json.mjs'

export { atomicWriteJson, renameWithRetry }

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

/**
 * 管理权威检查点读取与兼容投影校验。
 * 校验函数由外部注入，避免本模块耦合各子系统 schema。
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
