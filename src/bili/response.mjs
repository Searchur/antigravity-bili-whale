/**
 * B 站平台返回码与 HTTP 结果分类，由业务请求层和流量账本共同使用。
 */
const RATE_CODES = new Set([-412, -352, -799, -509, -10403, 10031])
const MANUAL_CODES = new Set([12015, 12051, -105])

export function biliCode(payload) {
  const raw = payload?.code
  if (Number.isSafeInteger(raw)) return raw
  if (typeof raw === 'string' && /^-?\d+$/.test(raw) && Number.isSafeInteger(Number(raw))) return Number(raw)
  return null
}

export function isJsonContentType(value) {
  return /(?:\/|\+)json$/i.test((value ?? '').split(';', 1)[0].trim())
}

export function isRateLimit(status, code) {
  return status === 412 || status === 429 || RATE_CODES.has(code)
}

export function requiresManual(status, code, authenticated) {
  return MANUAL_CODES.has(code) || (authenticated && (code === -101 || status === 401))
}

export function isExplicitRejection(status, code) {
  return status < 500 && code != null && code !== 0
}

export function failureKind(status, code) {
  if (MANUAL_CODES.has(code)) return 'manual'
  if (status === 401 || code === -101 || code === -111) return 'authentication'
  if (isRateLimit(status, code)) return 'rate-limit'
  if (status < 200 || status >= 300) return 'http'
  return code === null ? 'format' : 'rejected'
}
