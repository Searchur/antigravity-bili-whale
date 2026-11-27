/**
 * 后台投递账本读写与状态汇总：持久化唤醒与消息投递生命周期，防超时重发。
 */
import fs from 'node:fs'
import { atomicWriteJson } from '../core/atomic-json.mjs'
import { dataPathsFor } from '../core/paths.mjs'

const statuses = new Set(['dispatching', 'unconfirmed', 'accepted', 'failed'])
export function readDeliveries(whaleHome) {
  try {
    const data = JSON.parse(fs.readFileSync(dataPathsFor(whaleHome).deliveries, 'utf8'))
    if (data.schema !== 1 || !Array.isArray(data.records) || data.records.some(r =>
      typeof r.requestId!=='string'||!r.requestId||typeof r.attempt!=='string'||!r.attempt||
      typeof r.sessionId!=='string'||!r.sessionId||!Number.isFinite(r.startedAt)||!Number.isFinite(r.updatedAt)||!statuses.has(r.status))||
      new Set(data.records.map(r=>r.requestId)).size!==data.records.length) throw Error('invalid schema')
    return data.records
  } catch (e) {
    if (e.code === 'ENOENT') return []
    throw Error('投递账本无法读取，请检查 state/deliveries.json；不要删除未确认记录后重发')
  }
}

export function updateDelivery(whaleHome, requestId, update) {
  const records = readDeliveries(whaleHome)
  const index = records.findIndex(r => r.requestId === requestId)
  const next = {...(records[index] ?? {}), ...update, requestId}
  if (index < 0) records.push(next)
  else records[index] = next
  // 未确认请求与未签收私信绝不因诊断历史清理而过期，
  // 若未确认集合已满则在派发前停止。
  const protectedRecord = r => r.retained || ['dispatching', 'unconfirmed'].includes(r.status)
  const ordinary = records.filter(r => !protectedRecord(r)).sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 256)
  const kept = records.filter(protectedRecord).concat(ordinary)
  if (kept.length > 768) throw Error('未确认投递记录过多，请核查宿主会话；本轮不再投递')
  atomicWriteJson(dataPathsFor(whaleHome).deliveries, { schema: 1, records: kept }, { mode: 0o600 })
  return next
}

export function deliveryStatus(whaleHome) {
  const records = readDeliveries(whaleHome)
  const wakes = records.filter(r => r.channel === 'wake').sort((a, b) => b.startedAt - a.startedAt)
  let consecutiveFailures = 0
  for (const r of wakes) {
    if (!['failed', 'unconfirmed', 'dispatching'].includes(r.status)) break
    consecutiveFailures++
  }
  return {lastWake: wakes[0] ?? null, consecutiveFailures, alertClaimed:wakes.slice(0,consecutiveFailures).some(r=>r.noticeClaimedAt),
    unconfirmed: records.filter(r => ['dispatching', 'unconfirmed'].includes(r.status)).length}
}
