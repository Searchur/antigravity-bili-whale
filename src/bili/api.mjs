/**
 * B 站业务请求客户端，按登记的操作生成签名、解析结果并隔离只读缓存。
 */
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { WHALE_HOME, dataPathsFor } from '../core/paths.mjs'
import { diagnose } from '../core/diagnostics.mjs'
import { atomicWriteJson } from '../core/atomic-json.mjs'
import { exactJson } from '../core/json-exact.mjs'
import { createTrafficGuard, guardedFetch, trafficGuard } from './traffic.mjs'
import { biliEndpoint, biliOperationId } from './endpoints.mjs'
import { redactBiliMessage } from './cookie.mjs'
import { biliCode, failureKind, isExplicitRejection, isJsonContentType } from './response.mjs'

const MIXIN = [46,47,18,2,53,8,23,32,15,50,10,31,58,3,45,35,27,43,5,49,33,9,42,19,29,28,14,39,12,38,41,13,37,48,7,16,24,55,40,61,26,17,0,1,60,51,30,4,22,25,54,21,56,59,6,63,57,62,11,36,20,34,44,52]
const keyOf = value => String(value ?? '').split('/').at(-1).split('.')[0]

export function signWbi(params, images, now = Date.now()) {
  const first = keyOf(images?.img_url)
  const second = keyOf(images?.sub_url)
  if (first.length !== 32 || second.length !== 32) {
    throw Object.assign(Error('WBI 签名密钥缺失，请稍后重试或检查登录状态'), { code: 'WBI_UNAVAILABLE' })
  }
  const raw = first + second
  const key = MIXIN.map(index => raw[index]).join('').slice(0, 32)
  const values = { ...params, wts: Math.floor(now / 1000) }
  delete values.w_rid
  const query = Object.keys(values).sort().map(name =>
    encodeURIComponent(name) + '=' + encodeURIComponent(String(values[name]).replace(/[!'()*]/g, ''))).join('&')
  return query + '&w_rid=' + crypto.createHash('md5').update(query + key).digest('hex')
}

const DAY_MS = 24 * 60 * 60 * 1000
const NAV_TTL_MS = 10 * 60 * 1000
const FEED_SEARCH_TTL_MS = 10 * 60 * 1000
export const biliReadCacheEnabled = () => process.env.BILI_NO_CACHE !== '1'

function noteOptional(stage, error) {
  diagnose(stage, Object.assign(Error('B 站本地请求记录处理失败'), { code: error.code ?? error.name }))
}

function readCache(file) {
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf8'))
    return data && typeof data === 'object' && !Array.isArray(data) ? data : {}
  } catch (error) {
    if (error.code !== 'ENOENT') noteOptional('api-cache-read', error)
    return {}
  }
}

function saveCache(file, key, payload, status, maxEntries = 400) {
  const cache = readCache(file)
  cache[key] = { at: Date.now(), payload, status }
  const keys = Object.keys(cache)
  if (keys.length > maxEntries) {
    keys.sort((a, b) => Number(cache[a]?.at ?? 0) - Number(cache[b]?.at ?? 0))
    for (const oldest of keys.slice(0, keys.length - maxEntries)) delete cache[oldest]
  }
  try { atomicWriteJson(file, cache, { mode: 0o600 }) }
  catch (error) { noteOptional('api-cache-write', error) }
}

function logRead(file, source, id) {
  if (!biliReadCacheEnabled()) return
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.appendFileSync(file, `${new Date().toISOString()} ${source} ${id} 【${biliEndpoint(id).label}】\n`, { mode: 0o600 })
    if (fs.statSync(file).size > 1024 * 1024) {
      const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean).slice(-2000)
      fs.writeFileSync(file, lines.join('\n') + '\n', { mode: 0o600 })
    }
  } catch (error) { noteOptional('api-log-write', error) }
}

function cacheKey(id, params, headers) {
  const hs = new Headers(headers)
  const query = [...params].filter(([name]) => name !== 'wts' && name !== 'w_rid')
  query.sort(([a, av], [b, bv]) => a.localeCompare(b) || av.localeCompare(bv))
  // 新缓存键与旧解析器的条目隔离，避免读回已经失真的长整数。
  return 'v2:' + crypto.createHash('sha256').update(JSON.stringify([
    id, query, hs.get('cookie'), hs.get('authorization'),
  ])).digest('hex')
}

function queryParams(query) {
  return query instanceof URLSearchParams ? new URLSearchParams(query) :
    new URLSearchParams(Object.entries(query ?? {}).filter(([, value]) => value != null))
}

function operationUrl(route, params) {
  const pathname = route.path.replace(/\{([a-z]+)\}/g, (_, name) => {
    const value = params.get(name)
    if (!/^[1-9]\d{0,19}$/.test(value ?? '')) throw Error('B 站路径标识无效')
    params.delete(name)
    return value
  })
  const url = new URL(pathname, route.origin)
  url.search = params.toString()
  return url
}

function replyResult(id, status, payload, source = 'network', response, headers) {
  const httpOk = status >= 200 && status < 300
  const code = biliCode(payload)
  const raw = response !== undefined
  const ok = httpOk && (raw || code === 0)
  const rejected = isExplicitRejection(status, code)
  const kind = ok ? 'success' : failureKind(status, code)
  const message = redactBiliMessage(payload?.message ?? payload?.msg ?? (!httpOk ? 'HTTP ' + status : ok ? '' : 'B 站响应格式异常'), headers)
  const safePayload = payload
    ? { ...payload,
        ...(code !== null ? { code } : {}),
        ...('message' in payload ? { message: redactBiliMessage(payload.message, headers) } : {}),
        ...('msg' in payload ? { msg: redactBiliMessage(payload.msg, headers) } : {}) }
    : payload
  return { id, ok, status, code, data: httpOk ? safePayload?.data : undefined, payload: safePayload, message, kind, source, rejected,
    ...(raw ? { response } : {}) }
}

async function applySignature(route, url, signingParams, options, guard) {
  if (route.sign === 'none') return
  let keys = options.keys
  if (keys === undefined) {
    const identity = await requestBili('nav', { ...options, query: undefined, body: undefined, dispatch: undefined,
      noCache: route.method !== 'GET' || options.noCache })
    if (!identity.ok) guard.assertAvailable(options.headers)
    // 未登录的导航响应也可能提供公开 WBI 参数。
    if (identity.ok || (identity.status >= 200 && identity.status < 300 && identity.code === -101)) {
      keys = identity.data?.wbi_img
    }
  }
  const optional = route.sign === 'optional-form' || route.optionalSign
  let signedQuery
  try {
    const params = route.sign === 'optional-form'
      ? Object.fromEntries(new URLSearchParams(options.body))
      : Object.fromEntries(signingParams)
    signedQuery = signWbi(params, keys)
  } catch (error) {
    if (optional && error.code === 'WBI_UNAVAILABLE') return
    throw error
  }
  if (route.sign === 'optional-form') {
    const signature = new URLSearchParams(signedQuery)
    url.searchParams.set('wts', signature.get('wts'))
    url.searchParams.set('w_rid', signature.get('w_rid'))
  } else url.search = signedQuery
}

export async function requestBili(id, options = {}) {
  const route = biliEndpoint(id)
  if (route.lane !== 'business') throw Error('认证操作须使用专用认证入口')
  const { headers, signal, transport, directory, body, dispatch, waitWriteMs } = options
  const params = queryParams(options.query)
  const dims = dataPathsFor(directory ?? WHALE_HOME)
  const useCache = route.cache !== 'none' && !options.noCache && biliReadCacheEnabled()
  const key = useCache ? cacheKey(id, params, headers) : null
  const cache = useCache ? readCache(dims.apiCache)[key] : null
  const cachedAge = cache ? Date.now() - Number(cache.at) : Infinity
  const tier = route.cache === 'navigation' ? NAV_TTL_MS : options.ttlMs ?? DAY_MS
  const guard = directory ? createTrafficGuard({ directory }) : trafficGuard()
  const pause = guard.pauseStatus(headers)
  const staleAllowed = !pause.manual && route.cache === 'metadata' && cachedAge >= 0 && cachedAge < 7 * DAY_MS && cache?.payload?.code === 0
  const stale = () => {
    logRead(dims.apiRequestsLog, 'STALE', id)
    return replyResult(id, cache.status, cache.payload, 'stale', undefined, headers)
  }
  if (cache?.payload?.code === 0 && !pause.manual && !pause.cooldown && cachedAge >= 0 && cachedAge < tier) {
    logRead(dims.apiRequestsLog, 'HIT', id)
    return replyResult(id, cache.status, cache.payload, 'cache', undefined, headers)
  }
  if (pause.cooldown && staleAllowed) return stale()

  try {
    const url = operationUrl(route, params)
    await applySignature(route, url, params, options, guard)
    if (route.method === 'GET') logRead(dims.apiRequestsLog, 'NET', id)
    const response = await guardedFetch(url.href, {
      method: route.method, headers, signal, body, dispatch, waitWriteMs, transport, directory,
      operation: id, responseType: route.responseType, redirect: 'error',
    })
    const contentType = response.headers.get('content-type') ?? ''
    const expectsJson = route.responseType === 'json'
    if (!expectsJson && !isJsonContentType(contentType)) {
      return replyResult(id, response.status, null, 'network', response, headers)
    }
    const raw = await exactJson(response).catch(error => {
      if (error.name === 'TimeoutError' || error.name === 'AbortError') throw error
      return null
    })
    const payload = raw && typeof raw === 'object' && !Array.isArray(raw) && (expectsJson || biliCode(raw) !== 0) ? raw : null
    const result = { ...replyResult(id, response.status, payload, 'network', undefined, headers), contentType }
    if (result.kind === 'rate-limit' && staleAllowed && !guard.pauseStatus(headers).manual) return stale()
    if (result.ok && useCache) saveCache(dims.apiCache, key, result.payload, result.status)
    return result
  } catch (error) {
    if (error.pause?.cooldown && staleAllowed && !guard.pauseStatus(headers).manual) return stale()
    if (error.code === 'BILI_TRAFFIC_PAUSED' || error.code === 'WBI_UNAVAILABLE') throw error
    if (error.name === 'TimeoutError') {
      throw Object.assign(Error('B 站请求超时'), { kind: 'timeout', name: 'TimeoutError', code: 'BILI_REQUEST_TIMEOUT' })
    }
    if (error.name === 'AbortError') {
      throw Object.assign(Error('B 站请求已取消'), { kind: 'cancelled', name: 'AbortError', code: 'BILI_REQUEST_CANCELLED' })
    }
    throw Object.assign(Error('B 站请求失败，请稍后重试'), { kind: 'transport', code: 'BILI_REQUEST_FAILED' })
  }
}

export async function biliJson(id, options = {}) {
  try {
    const result = await requestBili(id, options)
    if (result.ok) return {
      ...result.payload,
      ...(result.source !== 'network' ? { _cached: true } : {}),
      ...(result.source === 'stale' ? { _stale: true } : {}),
    }
    const payload = result.status >= 200 && result.status < 300 ? result.payload : null
    return { ...payload, code: result.code || (result.kind === 'rate-limit' ? -412 : -1), message: result.message }
  } catch (error) {
    const message = error.kind || error.code === 'BILI_TRAFFIC_PAUSED' || error.code === 'WBI_UNAVAILABLE'
      ? redactBiliMessage(error.message, options.headers)
      : 'B 站请求失败，请稍后重试'
    return { code: error.pause?.cooldown ? -412 : -1, message }
  }
}

export async function searchFeedVideos({ keyword, order, days, account }, options = {}) {
  const { headers, directory } = options
  const dims = dataPathsFor(directory ?? WHALE_HOME)
  const now = Date.now()
  const query = { search_type: 'video', keyword, order, page: 1 }
  const useCache = !options.noCache && biliReadCacheEnabled()
  const key = useCache ? cacheKey('searchFeed', queryParams({ ...query, days, account }), headers) : null
  const entry = useCache ? readCache(dims.feedSearchCache)[key] : null
  if (entry?.payload?.code === 0 && now >= entry.at && now - entry.at < FEED_SEARCH_TTL_MS) {
    const guard = directory ? createTrafficGuard({ directory }) : trafficGuard()
    if (!guard.pauseStatus(headers).manual) return entry.payload
  }
  const end = Math.floor(now / 1000)
  const result = await biliJson('search', { ...options,
    query: { ...query, pubtime_begin_s: end - days * 86400, pubtime_end_s: end },
  })
  if (useCache && result.code === 0) saveCache(dims.feedSearchCache, key, result, 200, 40)
  return result
}

// 兼容旧调用和测试的 URL 形式，所有已登记业务操作仍经过同一客户端。
export async function apiGet(input, headers = {}, options = {}) {
  const url = new URL(input)
  const id = url.pathname === '/x/web-interface/view' ? 'view' :
    url.pathname === '/x/player/playurl' ? 'playUrl' : biliOperationId('GET', url.pathname)
  if (!id || url.origin !== biliEndpoint(id).origin || url.username || url.password) {
    return { code: -1, message: 'B 站读取地址未登记' }
  }
  return biliJson(id, { ...options, headers, query: url.searchParams })
}

export function apiState() {
  const { cooldown } = trafficGuard().pauseStatus({})
  return {
    banned: !!cooldown,
    banMinutesLeft: cooldown ? Math.ceil((cooldown.until - Date.now()) / 60000) : 0,
    banWhy: cooldown?.reason ?? null,
    cacheEntries: Object.keys(readCache(dataPathsFor(WHALE_HOME).apiCache)).length,
  }
}
