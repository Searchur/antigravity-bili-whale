/**
 * B 站接口签名与请求客户端：负责 WBI 签名、带风控保护的 GET 请求与接口状态查询。
 */
import { DATA_PATHS } from '../core/paths.mjs'
import { diagnose } from '../core/diagnostics.mjs'
import { guardedFetch as fetch } from './traffic.mjs'
import { atomicWriteJson } from '../core/atomic-json.mjs'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

const MIXIN = [46,47,18,2,53,8,23,32,15,50,10,31,58,3,45,35,27,43,5,49,33,9,42,19,29,28,14,39,12,38,41,13,37,48,7,16,24,55,40,61,26,17,0,1,60,51,30,4,22,25,54,21,56,59,6,63,57,62,11,36,20,34,44,52]
const keyOf = u => String(u).split('/').at(-1).split('.')[0]

export function signWbi(params, images, now = Date.now()) {
  const raw = keyOf(images?.img_url ?? '') + keyOf(images?.sub_url ?? '')
  if (raw.length !== 64) throw new Error('WBI 签名密钥缺失，请稍后重试或检查登录状态')
  const key = MIXIN.map(i => raw[i]).join('').slice(0, 32)
  const values = { ...params, wts: Math.floor(now / 1000) }
  delete values.w_rid
  const query = Object.keys(values).sort().map(k => `${encodeURIComponent(k)}=${encodeURIComponent(String(values[k]).replace(/[!'()*]/g, ''))}`).join('&')
  return `${query}&w_rid=${crypto.createHash('md5').update(query + key).digest('hex')}`
}

const CACHE_FILE = DATA_PATHS.apiCache
const BAN_FILE = DATA_PATHS.apiBan
const CACHE_TTL_MS = 24 * 3600 * 1000
const REQ_LOG = DATA_PATHS.apiRequestsLog
const MAX_REQ_LOG_BYTES = 1024 * 1024
const KEEP_REQ_LOG_LINES = 2000

const logReq = (hit, p) => {
  if (noCacheEnv()) return
  try {
    fs.mkdirSync(path.dirname(REQ_LOG), { recursive: true })
    fs.appendFileSync(REQ_LOG, `${new Date().toISOString()} ${hit ? 'HIT ' : 'NET '} ${p}\n`, { mode: 0o600 })
    const st = fs.statSync(REQ_LOG)
    if (st.size > MAX_REQ_LOG_BYTES) {
      const kept = fs.readFileSync(REQ_LOG, 'utf8').split(/\r?\n/).filter(Boolean).slice(-KEEP_REQ_LOG_LINES)
      fs.writeFileSync(REQ_LOG, kept.join('\n') + '\n', { mode: 0o600 })
    }
  } catch (e) { diagnose('api-optional-write', e) }
}

const CACHEABLE = [
  /^\/x\/web-interface\/(wbi\/)?view$/,
  /^\/x\/space\/wbi\/acc\/info$/,
]
const NAV_TTL_MS = 10 * 60 * 1000
const BAN_CODES = new Set([-412, -352, -799, -509, -10403])

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')) }
  catch (e) {
    if (e.code !== 'ENOENT') {
      diagnose('api-state-read', e)
      if (file === BAN_FILE) throw Error('风控状态损坏，停止请求')
    }
    return fallback
  }
}

function writeJson(file, value) {
  try {
    atomicWriteJson(file, value)
  } catch (e) {
    diagnose('api-optional-write', e)
    if (file === BAN_FILE) throw Error('风控状态保存失败，停止请求')
  }
}

function cacheKey(url, headers) {
  const u = new URL(url)
  if (u.pathname === '/x/web-interface/view') u.pathname = '/x/web-interface/wbi/view'
  const params = [...u.searchParams.entries()]
    .filter(([k]) => k !== 'wts' && k !== 'w_rid')
    .sort(([a, av], [b, bv]) => a.localeCompare(b) || av.localeCompare(bv))
  const h = new Headers(headers)
  const account = crypto.createHash('sha256').update(h.get('cookie') ?? '').update('\0').update(h.get('authorization') ?? '').digest('hex')
  return account + ':' + u.hostname + u.pathname + '?' + new URLSearchParams(params).toString()
}
const cacheable = (url) => {
  const u = new URL(url)
  return u.hostname === 'api.bilibili.com' && CACHEABLE.some((re) => re.test(u.pathname))
}
const isNav = (url) => {
  const u = new URL(url)
  return u.hostname === 'api.bilibili.com' && u.pathname === '/x/web-interface/nav'
}

const noCacheEnv = () => process.env.BILI_NO_CACHE === '1'

let lastRequestAt = 0
let requestQueue = Promise.resolve()
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
function throttle() {
  const turn = requestQueue.then(async () => {
    const gap = Date.now() - lastRequestAt
    if (gap < 300) await sleep(300 - gap)
    lastRequestAt = Date.now()
  })
  requestQueue = turn.catch(() => {})
  return turn
}

function bannedUntilNow() {
  const b = readJson(BAN_FILE, {})
  return Number(b.until ?? 0) > Date.now() ? Number(b.until) : 0
}

export async function apiGet(input, headers = {}, opts = {}) {
  const url = new URL(input)
  const ttl = opts.ttlMs ?? CACHE_TTL_MS
  const noCache = opts.noCache === true
  const key = cacheKey(url.href, headers)
  const canCache = cacheable(url.href) || isNav(url.href)
  const biliHost = url.hostname === 'bilibili.com' || url.hostname.endsWith('.bilibili.com')

  const stale = () => {
    if (noCache || noCacheEnv() || !cacheable(url.href)) return null
    const hit = readJson(CACHE_FILE, {})[key]
    return hit?.data?.code === 0 && Date.now() - Number(hit.at ?? 0) < 7 * CACHE_TTL_MS
      ? { ...hit.data, _cached: true, _stale: true } : null
  }

  try {
    const banned = noCacheEnv() || !biliHost ? 0 : bannedUntilNow()
    if (banned) {
      const mins = Math.max(1, Math.round((banned - Date.now()) / 60000))
      const hit = stale()
      if (hit) return hit
      return { code: -412, message: `HTTP 412 —— 本机被 B站 限流了，约 ${mins} 分钟后自动恢复（期间用缓存过日子）` }
    }

    if (!noCache && canCache && !noCacheEnv()) {
      const hit = readJson(CACHE_FILE, {})[key]
      const useTtl = isNav(url.href) ? NAV_TTL_MS : ttl
      if (hit && Date.now() - Number(hit.at ?? 0) < useTtl) { logReq(true, url.pathname); return { ...hit.data, _cached: true } }
    }

    const signedPaths = {
      '/x/web-interface/view': '/x/web-interface/wbi/view',
      '/x/player/playurl': '/x/player/wbi/playurl',
    }
    if (url.hostname === 'api.bilibili.com' && signedPaths[url.pathname]) {
      const nav = await apiGet('https://api.bilibili.com/x/web-interface/nav', headers, { noCache })
      if (!nav.data?.wbi_img) return { code: -1, message: `WBI 签名不可用：${nav.message || 'nav 未返回密钥'}` }
      url.pathname = signedPaths[url.pathname]
      url.search = signWbi(Object.fromEntries(url.searchParams), nav.data.wbi_img)
    }

    await throttle()
    if (biliHost && !noCacheEnv() && bannedUntilNow()) return stale() ?? { code: -412, message: 'B站风控退避中，请稍后重试' }

    logReq(false, url.pathname)
    const response = await fetch(url.href, { headers, signal: AbortSignal.timeout(30000) })

    if (biliHost && (response.status === 412 || response.status === 429)) {
      const prev = readJson(BAN_FILE, {})
      const streak = Number(prev.streak ?? 0) + 1
      const mins = Math.min(30, 5 * 2 ** (streak - 1))
      if (!noCacheEnv()) {
        writeJson(BAN_FILE, { until: Date.now() + mins * 60_000, why: `HTTP ${response.status}`, at: new Date().toISOString(), streak, endpoint: url.pathname })
      }
      const hit = stale()
      if (hit) return hit
      return { code: -412, message: `HTTP ${response.status}（B站 风控）—— 已熔断 ${mins} 分钟，别再打了` }
    }
    if (!response.ok) return { code: -1, message: `HTTP ${response.status}（B站风控或接口异常，请稍后重试；见 README 排障）` }

    const text = await response.text()
    let data
    try {
      data = JSON.parse(text)
      if (!data || typeof data !== 'object') throw new Error('invalid JSON payload')
    } catch {
      return { code: -1, message: `非 JSON 响应（HTTP ${response.status}），可能是风控或接口变更；见 README 排障` }
    }

    if (biliHost && BAN_CODES.has(Number(data.code))) {
      const prev = readJson(BAN_FILE, {})
      const streak = Number(prev.streak ?? 0) + 1
      const mins = Math.min(30, 5 * 2 ** (streak - 1))
      if (!noCacheEnv()) writeJson(BAN_FILE, { until: Date.now() + mins * 60_000, why: `code=${data.code}`, at: new Date().toISOString(), streak, endpoint: url.pathname })
      return { ...data, message: `${data.message ?? ''}（B站 风控 ${data.code}）—— 已熔断 ${mins} 分钟` }
    }

    if (Number(data.code) === 0) {
      const b = readJson(BAN_FILE, {})
      if (!noCacheEnv() && b.streak && Date.now() >= Number(b.until ?? 0)) writeJson(BAN_FILE, { ...b, streak: 0 })
      if (!noCache && canCache && !noCacheEnv()) {
        const store = readJson(CACHE_FILE, {})
        store[key] = { at: Date.now(), data }
        const keys = Object.keys(store)
        if (keys.length > 400) {
          keys.sort((a, b2) => Number(store[a].at ?? 0) - Number(store[b2].at ?? 0))
          for (const k of keys.slice(0, keys.length - 400)) delete store[k]
        }
        writeJson(CACHE_FILE, store)
      }
    }
    return data
  } catch (error) {
    return { code: -1, message: error.name === 'TimeoutError' ? '请求超时（30 秒）' : error.code === 'BILI_TRAFFIC_PAUSED' ? error.message : String(error?.message || '请求失败（网络异常或 WBI 签名密钥无效）') }
  }
}

export function apiState() {
  const ban = readJson(BAN_FILE, {})
  const cache = readJson(CACHE_FILE, {})
  const until = Number(ban.until ?? 0)
  return {
    banned: until > Date.now(),
    banMinutesLeft: until > Date.now() ? Math.ceil((until - Date.now()) / 60000) : 0,
    banWhy: ban.why ?? null,
    cacheEntries: Object.keys(cache).length,
  }
}
