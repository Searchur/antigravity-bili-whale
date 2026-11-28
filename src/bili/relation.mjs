/**
 * B 站关注关系校验与缓存：实时查询对方是否已关注大鲸鱼，按账号隔离缓存结果。
 */
import crypto from 'node:crypto'
import { biliReadCacheEnabled, requestBili } from './api.mjs'

const CACHE_TTL_MS = 10 * 60_000
const MAX_CACHE_ENTRIES = 500
const relationCache = new Map()

function cacheKeyFor(headers, mid) {
  const cookie = new Headers(headers || {}).get('cookie') ?? ''
  const sess = (cookie.match(/(?:^|;)\s*SESSDATA=([^;]+)/i) ?? [])[1] ?? cookie
  const scope = sess ? crypto.createHash('sha256').update(sess).digest('hex').slice(0, 16) : 'anon'
  return `${scope}:${mid}`
}

function setCached(key, entry) {
  if (relationCache.has(key)) relationCache.delete(key)
  relationCache.set(key, entry)
  if (relationCache.size > MAX_CACHE_ENTRIES) {
    const oldest = relationCache.keys().next().value
    if (oldest !== undefined) relationCache.delete(oldest)
  }
}

/**
 * 查询目标 UID 与大鲸鱼账号之间的关注关系（按当前账号隔离的 10 分钟缓存）。
 * - beAttribute === 2 或 6，或 attribute === 6 表示对方已关注大鲸鱼（是粉丝）。
 * - attribute === 128 或 beAttribute === 128 表示存在拉黑关系。
 */
export async function checkRelation(targetMid, headers, { fetchImpl, directory, now = Date.now, fresh = false } = {}) {
  const mid = String(targetMid ?? '').trim()
  if (!/^[1-9]\d{0,19}$/.test(mid)) {
    return { ok: false, isFollower: false, isMutual: false, isBlocked: false, attribute: -1, beAttribute: -1, why: 'UID 无效' }
  }
  const key = cacheKeyFor(headers, mid)
  const hit = relationCache.get(key)
  const useCache = biliReadCacheEnabled()
  if (useCache && !fresh && hit && now() - hit.at < CACHE_TTL_MS) return hit.value

  const parseResult = (attr, beAttr) => {
    const a = Number(attr ?? -1)
    const b = beAttr == null ? null : Number(beAttr)
    const isBlocked = a === 128 || b === 128
    const isMutual = a === 6
    const isFollower = !isBlocked && (isMutual || b === 2 || b === 6)
    const ok = isBlocked || isMutual || [0,1,2,6].includes(b)
    return { ok, isFollower, isMutual, isBlocked, attribute: a, beAttribute: b,
      ...(!ok && { why: '关系接口未返回对方的关注状态' }) }
  }

  try {
    const r1 = await requestBili('relationDetail', { query: { mid }, headers, transport: fetchImpl, directory })
    if (r1.ok && r1.data) {
      const value = parseResult(r1.data.relation?.attribute, r1.data.be_relation?.attribute)
      if (value.ok) {
        if (useCache) setCached(key, { at: now(), value })
        return value
      }
    }
  } catch (error) {
    if (error.code === 'BILI_TRAFFIC_PAUSED') {
      return { ok: false, isFollower: false, isMutual: false, isBlocked: false, attribute: -1, beAttribute: -1, why: error.message }
    }
  }

  try {
    const r2 = await requestBili('relation', { query: { fid: mid }, headers, transport: fetchImpl, directory })
    if (r2.ok && r2.data) {
      const value = parseResult(r2.data.attribute, r2.data.be_relation?.attribute)
      if (useCache && value.ok) setCached(key, { at: now(), value })
      return value
    }
    return { ok: false, isFollower: false, isMutual: false, isBlocked: false, attribute: -1, beAttribute: -1, why: `关系接口 code=${r2?.code ?? 'err'}` }
  } catch (e) {
    return { ok: false, isFollower: false, isMutual: false, isBlocked: false, attribute: -1, beAttribute: -1, why: String(e?.message ?? e) }
  }
}

export async function isFollowerOfWhale(targetMid, headers, opts = {}) {
  const rel = await checkRelation(targetMid, headers, opts)
  return rel.ok && rel.isFollower && !rel.isBlocked
}

export function clearRelationCache() {
  relationCache.clear()
}
