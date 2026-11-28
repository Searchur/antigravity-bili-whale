/**
 * B 站私信只读接口，负责 WBI 签名、精确保留会话位置以及区分空页与请求失败。
 */
import { requestBili } from './api.mjs'

export function dmPosition(value) {
  if (typeof value === 'number' && !Number.isSafeInteger(value)) return null
  if (typeof value !== 'number' && typeof value !== 'string') return null
  const digits = String(value)
  return /^\d{1,20}$/.test(digits) ? BigInt(digits).toString() : null
}

export function dmMessageKey(value) {
  if (typeof value !== 'string' && !Number.isSafeInteger(value)) return null
  const key = String(value)
  return key && key !== '0' ? key : null
}

export function dmReadError(code) {
  return Object.assign(new Error(`B 站私信读取失败（${code}）`), { code })
}

export function dmReadIssue(stage, error) {
  const code = error?.code
  return { stage, code: Number.isSafeInteger(code) || (typeof code === 'string' && /^[A-Z0-9_-]{1,40}$/.test(code)) ? code : 'READ_FAILED' }
}

async function privatePage(id, params, field, headers, keys) {
  const reply = await requestBili(id, { query: { ...params, build: 0, mobi_app: 'web' }, headers, keys: keys ?? null })
  if (!reply.ok) {
    throw dmReadError(reply.code || (reply.status >= 400 ? 'HTTP_' + reply.status : 'INVALID_RESPONSE'))
  }
  const data = reply.data
  if (!data || typeof data !== 'object') throw dmReadError('INVALID_RESPONSE')
  if (data.has_more != null && ![true, false, 1, 0, '1', '0'].includes(data.has_more)) {
    throw dmReadError('INVALID_RESPONSE')
  }
  const hasMore = [true, 1, '1'].includes(data.has_more)
  const rows = data[field] === null && !hasMore ? [] : data[field]
  if (!Array.isArray(rows)) throw dmReadError('INVALID_RESPONSE')
  return { rows, hasMore, data }
}

export async function privateHistoryPage(talker, endSeq, headers, keys) {
  const size = 30
  const page = await privatePage('dmHistory', {
    talker_id: talker,
    session_type: 1,
    sender_device_id: '1',
    size,
    ...(endSeq ? { end_seqno: endSeq } : {}),
  }, 'messages', headers, keys)
  return {
    rows: page.rows,
    hasMore: page.hasMore || (page.data.has_more === undefined && page.rows.length === size),
    minSeq: dmPosition(page.data.min_seqno),
    maxSeq: dmPosition(page.data.max_seqno),
  }
}

export async function privateSessionsPage(endTs, headers, keys) {
  const { rows, hasMore } = await privatePage('dmSessions', {
    session_type: 1, group_fold: 1, unfollow_fold: 0, sort_rule: 2, size: 20,
    ...(endTs ? { end_ts: endTs } : {}),
  }, 'session_list', headers, keys)
  const next = hasMore ? dmPosition(rows.at(-1)?.session_ts) : null
  if (hasMore && (!next || next === '0' || (endTs && BigInt(next) >= BigInt(endTs)))) {
    throw dmReadError('CURSOR_STALLED')
  }
  return { rows, next }
}
