import { guardedFetch as fetch } from './traffic.mjs'
import { exactJson } from './json-exact.mjs'

const CACHE_TTL_MS = 10 * 60_000
const relationCache = new Map()

/**
 * 查询目标 UID 与大鲸鱼账号之间的关注关系（带 10 分钟缓存）。
 * - beAttribute === 2 或 6，或 attribute === 6 表示对方已关注大鲸鱼（是粉丝）。
 * - attribute === 128 或 beAttribute === 128 表示存在拉黑关系。
 */
export async function checkRelation(targetMid, headers, { fetchImpl = fetch, now = Date.now, fresh = false } = {}) {
  const mid = String(targetMid ?? '').trim()
  if (!/^[1-9]\d{0,19}$/.test(mid)) {
    return { ok: false, isFollower: false, isMutual: false, isBlocked: false, attribute: -1, beAttribute: -1, why: 'UID 无效' }
  }
  const hit = relationCache.get(mid)
  if (!fresh && hit && now() - hit.at < CACHE_TTL_MS) return hit.value

  const parseResult = (attr, beAttr) => {
    const a = Number(attr ?? -1)
    const b = beAttr == null ? null : Number(beAttr)
    const isBlocked = a === 128 || b === 128
    const isMutual = a === 6
    const isFollower = !isBlocked && (isMutual || b === 2 || b === 6)
    return { ok: true, isFollower, isMutual, isBlocked, attribute: a, beAttribute: b }
  }

  try {
    // 优先使用 /x/space/acc/relation（明确返回 relation 与 be_relation）
    const r1 = await exactJson(await fetchImpl(`https://api.bilibili.com/x/space/acc/relation?mid=${encodeURIComponent(mid)}`, { headers }))
    if (r1?.code === 0 && r1.data) {
      const value = parseResult(r1.data.relation?.attribute, r1.data.be_relation?.attribute)
      relationCache.set(mid, { at: now(), value })
      return value
    }
  } catch {}

  try {
    const r2 = await exactJson(await fetchImpl(`https://api.bilibili.com/x/relation?fid=${encodeURIComponent(mid)}`, { headers }))
    if (r2?.code === 0 && r2.data) {
      const value = parseResult(r2.data.attribute, r2.data.be_relation?.attribute)
      relationCache.set(mid, { at: now(), value })
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
