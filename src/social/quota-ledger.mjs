/**
 * 外发配额账本持久化与未结案回执恢复器：保障并发记账合并与去重计数。
 */
import fs from 'node:fs'
import path from 'node:path'
import { DATA_PATHS } from '../core/paths.mjs'
import { atomicWriteJson } from '../core/atomic-json.mjs'
import { acquireProcessLock } from '../core/process-lock.mjs'

const file = DATA_PATHS.quota
const recoveryDir = DATA_PATHS.quotaRecoveryDir

// 派发前持久化定位器：账号或主人切换不得隐藏
// 共享限额中的已确认回执，私人正文保留在独立存储中。
export function trackQuotaOperation(operationId, account, owner) {
  atomicWriteJson(path.join(recoveryDir, operationId + '.json'), { operationId, account, owner })
}

export async function recoverQuotaReceipts(openStore) {
  const reservations = []
  let names
  try { names = fs.readdirSync(recoveryDir) }
  catch (error) { if (error.code === 'ENOENT') return reservations; throw error }
  for (const name of names.filter(name => /^[\da-f-]{36}\.json$/.test(name))) {
    const locator = path.join(recoveryDir, name)
    let record
    try { record = JSON.parse(fs.readFileSync(locator, 'utf8')) }
    catch (error) { if (error.code === 'ENOENT') continue; throw error }
    const { operationId, account, owner } = record
    if (operationId + '.json' !== name || !account || !owner) throw Error('额度恢复索引格式错误')
    const snapshot = openStore(account, owner).read()
    const pending = snapshot.pending[operationId]
    if (pending) {
      if (pending.phase !== 'prepared') reservations.push({
        operationId, type: pending.channel, target: pending.quotaTarget,
        auto: !!pending.auto, share: !!pending.share, at: pending.dispatchedAt ?? pending.at,
      })
      continue
    }
    const receipt = snapshot.settings.quotaReceipts?.find(row => row.operationId === operationId)
    if (receipt) await appendQuotaRows([receipt])
    fs.rmSync(locator, { force: true })
  }
  return reservations
}

export function readQuotaLog() {
  let contents
  try { contents = fs.readFileSync(file, 'utf8') }
  catch (error) { if (error.code === 'ENOENT') return []; throw error }
  const ledger = JSON.parse(contents)
  if (!Array.isArray(ledger?.log)) throw Error('quota.json 缺少有效的 log 数组')
  return ledger.log
}

export async function appendQuotaRows(rows) {
  const release = await acquireProcessLock(file, { retries: 100 })
  try {
    const log = readQuotaLog()
    const ids = new Set(log.map(row => row.operationId).filter(Boolean))
    for (const row of rows) {
      if (row.operationId && ids.has(row.operationId)) continue
      log.push(row)
      ids.add(row.operationId)
    }
    atomicWriteJson(file, { log })
    return log
  } finally { await release() }
}

export async function flushQuotaReceipts(store) {
  const pending = store.read().settings.quotaReceipts ?? []
  if (!pending.length) return
  try {
    await appendQuotaRows(pending)
    const ids = new Set(pending.map(row => row.operationId))
    await store.tx(state => {
      state.settings.quotaReceipts = (state.settings.quotaReceipts ?? []).filter(row => !ids.has(row.operationId))
    })
    for (const id of ids) fs.rmSync(path.join(recoveryDir, id + '.json'), { force: true })
  } catch (error) {
    throw Error('平台已接受发送，回执已保存，额度待补账。修复账本后运行 quota status；请勿重发。原因：' + error.message)
  }
}

