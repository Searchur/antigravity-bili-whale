/**
 * B 站扫码登录、凭据核验与注销：管理单实例二维码挑战及限于登录流程的请求。
 */
import { randomUUID } from 'node:crypto'
import { parseJsonExact } from '../core/json-exact.mjs'
import { biliHeaders } from './cookie.mjs'
import { biliEndpoint } from './endpoints.mjs'
import { qrDataUrl } from './qr.mjs'
import { AuthError, parseManualCookie } from './credential-store.mjs'

export async function renderQr(url, {encoder, signal}={}) {
  if (signal?.aborted) throw new AuthError('登录已取消。')
  try {
    return typeof encoder?.toDataURL === 'function'
      ? await encoder.toDataURL(url, {width:220, margin:2})
      : qrDataUrl(url, {width:220, margin:2})
  } catch { throw new AuthError('二维码绘制失败。') }
}

const PASSPORT = biliEndpoint('qrStart').origin
const SITE = 'https://www.bilibili.com/'
const AUTH_BODY_LIMIT = 128 * 1024
const INTERVAL = 2000
const TTL = 180000
const terminal = new Set(['success', 'expired', 'cancelled', 'error'])

async function readAuthJson(response, signal) {
  if (Number(response.headers.get('content-length')) > AUTH_BODY_LIMIT) throw Error()
  const reader = response.body.getReader()
  const stop = () => { void reader.cancel().catch(() => {}) }
  signal.addEventListener('abort', stop, { once: true })
  try {
    const chunks = []
    let size = 0
    for (;;) {
      signal.throwIfAborted()
      const { value, done } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > AUTH_BODY_LIMIT) throw Error()
      chunks.push(value)
    }
    signal.throwIfAborted()
    return parseJsonExact(Buffer.concat(chunks, size).toString('utf8'))
  } finally {
    signal.removeEventListener('abort', stop)
    await reader.cancel().catch(() => {})
    reader.releaseLock()
  }
}

async function authRequest(id, {
  fetch: transport = globalThis.fetch, signal, credentials, query, body, timeoutMs = 15_000,
  referer = PASSPORT + '/login',
} = {}) {
  const endpoint = biliEndpoint(id)
  if (endpoint.lane !== 'auth') throw Error()
  const url = new URL(endpoint.path, endpoint.origin)
  if (query) url.search = new URLSearchParams(query).toString()
  const timeout = AbortSignal.timeout(timeoutMs)
  const requestSignal = signal ? AbortSignal.any([signal, timeout]) : timeout
  requestSignal.throwIfAborted()
  const logout = id === 'logout'
  const response = await transport(url.href, {
    method: endpoint.method, redirect: logout ? 'manual' : 'error', signal: requestSignal, body,
    headers: biliHeaders(credentials, { referer, userAgent: 'Mozilla/5.0' }),
  })
  try {
    requestSignal.throwIfAborted()
    if (response.redirected) throw Error()
    if (logout && [301, 302].includes(response.status)) return { acceptedRedirect: true }
    if (!response.ok || !response.body) throw Error()
    return { result: await readAuthJson(response, requestSignal), headers: response.headers }
  } finally {
    if (response.body && !response.bodyUsed) await response.body.cancel().catch(() => {})
  }
}

async function loginRequest(id, options) {
  try {
    const { result, headers } = await authRequest(id, options)
    if (result?.code !== 0) throw Error()
    return { data: result.data, headers }
  } catch {
    throw new AuthError(options.signal?.aborted ? '登录已取消。' : 'B 站登录请求失败，请稍后重试。')
  }
}

export async function verifyAccount(input, { fetch, signal } = {}) {
  const credentials = parseManualCookie(input)
  const { data } = await loginRequest('authNav', { fetch, credentials, signal })
  const mid = data?.mid
  if (data?.isLogin !== true || (typeof mid !== 'string' && !Number.isSafeInteger(mid)) || !/^[1-9]\d{0,19}$/.test(String(mid)))
    throw new AuthError('登录验证失败，原登录状态未替换。')
  let name = typeof data.uname === 'string' ? data.uname.slice(0, 200) : ''
  for (const secret of Object.values(credentials)) if (secret) name = name.split(secret).join('[redacted]')
  return { mid: String(mid), name }
}

export async function revokeRemoteSession(input, { fetch } = {}) {
  let credentials
  try { credentials = parseManualCookie(input) } catch { return 'local_only' }
  const options = { fetch, credentials, referer: SITE, timeoutMs: 8_000 }
  const body = new URLSearchParams({ biliCSRF: credentials.bili_jct, gourl: SITE })
  let exitAccepted = false
  try {
    const { acceptedRedirect, result } = await authRequest('logout', { ...options, body })
    exitAccepted = acceptedRedirect === true || result?.code === 0
  } catch { /* 独立复核注销后的远程登录状态。 */ }
  try {
    const { result } = await authRequest('authNav', options)
    if (result?.code === -101 || (result?.code === 0 && result.data?.isLogin === false)) return 'verified_revoked'
    if (result?.code === 0 && result.data?.isLogin === true) return 'still_active'
  } catch { /* 无法完成复核时按注销响应报告。 */ }
  return exitAccepted ? 'exit_accepted' : 'local_only'
}

/** 每个插件实例仅维护一个短时扫码挑战；Cookie、密钥与刷新令牌绝不透传至前端 UI。 */
export class QrAuth {
  constructor({ save, fetch = globalThis.fetch, now = Date.now, render = (url, signal) => renderQr(url, {signal}) }) {
    this.save = save; this.fetch = fetch; this.now = now; this.render = render
    this.current = null; this.nextStart = 0; this.disposed = false
  }
  state(session) {
    return { id: session.id, status: session.status, expiresAt: session.expiresAt,
      ...(session.status === 'waiting' || session.status === 'scanned' ? { image: session.image } : {}),
      ...(session.account ? { account: session.account } : {}),
      ...(session.error ? { error: session.error } : {}) }
  }
  check(session) {
    if (this.disposed || this.current !== session || session.controller.signal.aborted)
      throw new AuthError('登录流程已失效，请重新扫码。')
    if (this.now() >= session.expiresAt) { session.status = 'expired'; throw new AuthError('二维码已过期，请重新生成。') }
  }
  async start() {
    if (this.disposed) throw new AuthError('登录服务已关闭。')
    if (this.now() < this.nextStart) throw new AuthError('请稍等两秒后再生成二维码。')
    this.nextStart = this.now() + INTERVAL
    this.cancel()
    const session = { id: randomUUID(), status: 'waiting', controller: new AbortController(), expiresAt: this.now() + TTL, nextPoll: this.now() + INTERVAL }
    this.current = session
    try {
      const { data } = await loginRequest('qrStart', { fetch: this.fetch, signal: session.controller.signal })
      this.check(session)
      let url
      try { url = new URL(data?.url) } catch { throw new AuthError('二维码响应无效，请稍后重试。') }
      if (![PASSPORT, 'https://account.bilibili.com'].includes(url.origin) || url.username || url.password
        || typeof data?.qrcode_key !== 'string' || !/^[A-Za-z0-9_-]{1,256}$/.test(data.qrcode_key))
        throw new AuthError('二维码响应无效，请稍后重试。')
      session.key = data.qrcode_key
      session.image = await this.render(url.href, session.controller.signal)
      this.check(session)
      return this.state(session)
    } catch (error) {
      session.status = session.controller.signal.aborted ? 'cancelled' : 'error'
      delete session.key; delete session.image
      throw error instanceof AuthError ? error : new AuthError('二维码生成失败，请重试。')
    }
  }
  async poll(id) {
    const session = this.current
    if (!session || session.id !== id) throw new AuthError('登录流程已失效，请重新扫码。')
    if (terminal.has(session.status)) return this.state(session)
    if (this.now() >= session.expiresAt) {
      session.status = 'expired'; session.controller.abort(); delete session.key; delete session.image
      return this.state(session)
    }
    if (session.flight) return session.flight
    if (this.now() < session.nextPoll) return this.state(session)
    session.nextPoll = this.now() + INTERVAL
    session.flight = this.pollOnce(session).finally(() => { session.flight = null })
    return session.flight
  }
  async pollOnce(session) {
    try {
      const { data, headers } = await loginRequest('qrPoll', {
        fetch: this.fetch, signal: session.controller.signal, query: { qrcode_key: session.key },
      })
      this.check(session)
      if (data?.code === 86101) session.status = 'waiting'
      else if (data?.code === 86090) session.status = 'scanned'
      else if (data?.code === 86038) session.status = 'expired'
      else if (data?.code === 0) {
        const values = {}
        for (const cookie of headers.getSetCookie()) {
          const pair = cookie.split(';', 1)[0], split = pair.indexOf('=')
          if (split < 1) continue
          const name = pair.slice(0, split).trim()
          if (['SESSDATA', 'bili_jct', 'buvid3'].includes(name)) values[name] = pair.slice(split + 1).trim()
        }
        const credentials = parseManualCookie({ sessdata: values.SESSDATA, bili_jct: values.bili_jct, buvid3: values.buvid3 })
        const account = await this.save(credentials, { signal: session.controller.signal, check: () => this.check(session) })
        if (this.current === session && !session.controller.signal.aborted) {
          session.account = account
          session.status = 'success'
        }
      } else throw new AuthError('无法识别登录状态，请重新扫码。')
    } catch (error) {
      if (!terminal.has(session.status)) {
        session.status = session.controller.signal.aborted ? 'cancelled' : 'error'
        session.error = error instanceof AuthError ? error.message : '登录未保存，请重新扫码。'
      }
    }
    if (terminal.has(session.status)) { delete session.key; delete session.image }
    return this.state(session)
  }
  cancel(id) {
    const session = this.current
    if (!session || (id && session.id !== id)) return { status: 'cancelled' }
    if (!terminal.has(session.status)) session.status = 'cancelled'
    session.controller.abort(); delete session.key; delete session.image
    return this.state(session)
  }
  dispose() { this.disposed = true; this.cancel() }
}
