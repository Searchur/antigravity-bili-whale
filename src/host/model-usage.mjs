/**
 * 将 Antigravity 原生用量摘要规整为模型组的周额度和五小时额度。
 */
import { isKnownQuotaFraction, MODEL_QUOTA_GROUP_NAMES } from '../shared/model-quota.mjs'

export const UNAVAILABLE_MODEL_USAGE = Object.freeze({ state: 'unavailable', checkedAt: null, groups: Object.freeze([]) })

const PERIODS = ['weekly', 'five-hour']

function quotaGroupId(name) {
  const text = String(name ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()
  if (/^gemini(?: models?)?$/.test(text)) return 'gemini'
  if (/^claude(?: and)? gpt(?: models?)?$/.test(text)) return 'claude-gpt'
  return null
}

function quotaPeriod(bucket) {
  const windows = Array.isArray(bucket.window) ? bucket.window : [bucket.window]
  for (const label of [...windows, bucket.displayName, bucket.bucketId]) {
    const text = String(label ?? '').toLowerCase().replace(/[_-]+/g, ' ').trim()
    if (/^(?:p?1w|p?7d|604800s?)$|\bweek(?:ly)?\b/.test(text)) return 'weekly'
    if (/^(?:pt)?5h$|^18000s?$|\b(?:five|5)\s*(?:hours?|hrs?|h)\b/.test(text)) return 'five-hour'
  }
  return null
}

export function normalizeModelUsage(raw, checkedAt = new Date().toISOString()) {
  const groups = raw?.response?.groups
  if (!Array.isArray(groups)) return UNAVAILABLE_MODEL_USAGE

  const normalized = []
  for (const [id, name] of Object.entries(MODEL_QUOTA_GROUP_NAMES)) {
    const matching = groups.filter(group => quotaGroupId(group?.displayName) === id)
    if (!matching.length) continue
    const buckets = matching.flatMap(group => group.buckets ?? []).filter(bucket => bucket && typeof bucket === 'object')
    const windows = PERIODS.map(period => {
      const bucket = buckets.find(item => quotaPeriod(item) === period)
      const fraction = bucket?.remainingFraction
      return {
        period,
        remainingFraction: isKnownQuotaFraction(fraction) ? fraction : null,
        resetTime: typeof bucket?.resetTime === 'string' && Number.isFinite(Date.parse(bucket.resetTime)) ? bucket.resetTime : null,
        disabled: bucket?.disabled === true,
      }
    })
    normalized.push({ id, name, windows })
  }
  return normalized.length ? { state: 'ready', checkedAt, groups: normalized } : UNAVAILABLE_MODEL_USAGE
}
