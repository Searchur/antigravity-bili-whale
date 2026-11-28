/**
 * B 站媒体请求：校验各类 CDN 地址与逐跳重定向，按需传递公开请求头及视频字节范围。
 */
const CDN_HOSTS = new Map([
  ['image', ['hdslb.com']],
  ['subtitle', ['hdslb.com']],
  ['video', ['bilivideo.com', 'bilivideo.cn']],
])
const PRIVATE_QUERY = new Set([
  'sessdata', 'bili_jct', 'buvid3', 'buvid4', 'bili_ticket', 'dedeuserid', 'dedeuserid__ckmd5',
  'csrf', 'csrf_token', 'bilicsrf', 'access_key', 'access_token', 'refresh_token', 'cookie', 'authorization',
  'qrcode_key', 'w_rid', 'wts',
])
const VIDEO_BINARY_TYPES = new Set(['application/octet-stream', 'binary/octet-stream', 'application/mp4', 'application/x-flv'])
const REDIRECT_STATUS = new Set([301, 302, 303, 307, 308])
const MAX_REDIRECTS = 3
const SITE = 'https://www.bilibili.com'

export function biliMediaUrl(input, kind, base) {
  let url
  try { url = new URL(typeof input === 'string' && input.startsWith('//') ? 'https:' + input : input, base) }
  catch { throw Error('B 站媒体地址无效。') }
  const allowed = CDN_HOSTS.get(kind)?.some(host => url.hostname === host || url.hostname.endsWith('.' + host))
  if (!allowed || url.protocol !== 'https:' || url.port || url.username || url.password ||
    [...url.searchParams.keys()].some(key => PRIVATE_QUERY.has(key.toLowerCase()))) {
    throw Error('B 站媒体地址超出允许范围。')
  }
  url.hash = ''
  return url
}

export function isBiliMediaRange(value) {
  if (typeof value !== 'string') return false
  const match = /^bytes=(\d{0,16})-(\d{0,16})$/.exec(value)
  if (!match || (!match[1] && !match[2])) return false
  const [, start, end] = match
  return Number.isSafeInteger(Number(start)) && Number.isSafeInteger(Number(end)) &&
    (!end || Number(end) >= (start ? Number(start) : 1))
}

export function parseBiliMediaContentRange(value) {
  const match = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(value ?? '')
  if (!match) return null
  const [start, end, total] = match.slice(1).map(Number)
  if (![start, end, total].every(Number.isSafeInteger) || end < start || end >= total) return null
  return { start, end, total, length: end - start + 1 }
}

export async function* limitMediaBytes(source, limit, exact = false) {
  let bytes = 0
  for await (const chunk of source) {
    bytes += chunk.byteLength
    if (bytes > limit) throw Error('媒体响应超出声明的字节范围。')
    yield chunk
  }
  if (exact && bytes !== limit) throw Error('媒体响应短于声明的字节范围。')
}

function publicMediaHeaders(input, kind) {
  const supplied = new Headers(input)
  const headers = new Headers()
  for (const name of ['accept', 'user-agent']) {
    if (supplied.has(name)) headers.set(name, supplied.get(name))
  }
  try {
    const from = new URL(supplied.get('referer'))
    if (from.origin === SITE && !from.username && !from.password) {
      from.search = ''
      from.hash = ''
      headers.set('referer', from.href)
    }
  } catch { /* 无合规来源时直接匿名读取媒体。 */ }
  if (kind === 'video') {
    // Range 使用原始字节偏移，不能由 HTTP 内容编码改变。
    headers.set('accept-encoding', 'identity')
    if (supplied.has('range')) {
      const range = supplied.get('range')
      if (!isBiliMediaRange(range)) throw Error('视频字节范围无效。')
      headers.set('range', range)
    }
  }
  return headers
}

export async function fetchBiliMedia(input, {
  kind, headers, method = 'GET', signal = AbortSignal.timeout(20_000), transport = globalThis.fetch,
} = {}) {
  if (method !== 'GET' && method !== 'HEAD') throw Error('B 站媒体请求方法无效。')
  let target = biliMediaUrl(input, kind)
  const safeHeaders = publicMediaHeaders(headers, kind)
  for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects++) {
    signal.throwIfAborted()
    let response
    try {
      response = await transport(target.href, {
        method, headers: new Headers(safeHeaders), redirect: 'manual', credentials: 'omit', signal,
      })
    } catch { throw Error('B 站媒体请求失败。') }
    if (!signal.aborted && !response.redirected && !REDIRECT_STATUS.has(response.status)) {
      if (kind === 'video' && (response.status === 200 || response.status === 206)) {
        const type = response.headers.get('content-type')?.split(';', 1)[0].trim().toLowerCase()
        if (!(method === 'HEAD' && !type) && !/^video\/[a-z0-9.+-]+$/.test(type ?? '') && !VIDEO_BINARY_TYPES.has(type)) {
          await response.body?.cancel().catch(() => {})
          throw Error('B 站视频响应类型无效。')
        }
      }
      return response
    }
    await response.body?.cancel().catch(() => {})
    signal.throwIfAborted()
    const location = response.headers.get('location')
    if (response.redirected || !location || redirects === MAX_REDIRECTS) throw Error('B 站媒体重定向无效。')
    target = biliMediaUrl(location, kind, target)
  }
}
