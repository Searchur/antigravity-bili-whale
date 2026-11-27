import { normalizeModels } from '../tools/lib/config.mjs'
import { belowQuotaThreshold, remainingQuotaPercent } from './quota-percentage.js'

const LIGHT_MODEL = /(?:^|[^a-z0-9])(?:lite|mini)(?:$|[^a-z0-9])|flashlite/i

function pickLiveModel(catalog, modelId) {
  const live = (catalog?.models ?? []).filter(
    m => m && m.groupKey !== 'auto-tier' && Number.isFinite(m.remainingFraction),
  )
  if (!live.length) return null
  const exact = live.find(m => m.id === modelId)
  if (exact) return exact

  // 自适应档位（flash / flash_lite / pro）按命名启发式映射至对应实时模型配额
  const id = String(modelId || '').toLowerCase()
  if (id === 'flash_lite') {
    return live.find(m => LIGHT_MODEL.test(`${m.id} ${m.label}`)) ?? null
  }
  if (id === 'flash') {
    return live.find(m => /flash|hydrogen|carbon/i.test(`${m.id} ${m.label}`) && !LIGHT_MODEL.test(`${m.id} ${m.label}`)) ?? null
  }
  if (id === 'pro') {
    return live.find(m => /pro|neon|opus|sonnet/i.test(`${m.id} ${m.label}`)) ?? null
  }
  return null
}

/**
 * 评估当前所选模型剩余配额是否低于用户设置的保护阈值。
 */
export function evaluateModelQuota(catalog, rawModelCfg) {
  const cfg = normalizeModels(rawModelCfg)
  const threshold = cfg.minQuotaPercent
  if (threshold <= 0) {
    return {
      enabled: false,
      paused: false,
      threshold: 0,
      remainingPercent: null,
      modelId: cfg.main,
      modelLabel: '',
      resetTime: null,
      reason: '',
    }
  }
  if (!catalog || catalog.source !== 'live') {
    return {
      enabled: true,
      paused: false,
      threshold,
      remainingPercent: null,
      modelId: cfg.main,
      modelLabel: '',
      resetTime: null,
      reason: '',
    }
  }
  const main = pickLiveModel(catalog, cfg.main)
  const worker = pickLiveModel(catalog, cfg.worker)
  const hit = worker && (!main || worker.remainingFraction < main.remainingFraction) ? worker : main
  if (!hit) {
    return {
      enabled: true,
      paused: false,
      threshold,
      remainingPercent: null,
      modelId: cfg.main,
      modelLabel: '',
      resetTime: null,
      reason: '',
    }
  }
  const remainingPercent = remainingQuotaPercent(hit.remainingFraction)
  const modelLabel = hit.groupName
    ? (hit.thinkingLabel && hit.thinkingLabel !== '默认' ? `${hit.groupName} · ${hit.thinkingLabel}` : hit.groupName)
    : (hit.label || hit.id)
  const paused = belowQuotaThreshold(hit.remainingFraction, threshold)
  return {
    enabled: true,
    paused,
    threshold,
    remainingPercent,
    modelId: hit.id,
    modelLabel,
    resetTime: hit.resetTime || null,
    reason: paused
      ? `模型「${modelLabel}」剩余配额 ${remainingPercent}% 低于保护阈值 ${threshold}%，已暂停全部后台活动`
      : '',
  }
}

/**
 * 后台调度使用的带短缓存模型配额守卫：
 * - 当配置阈值 = 0 时零 RPC 开销；
 * - 当剩余配额低于阈值时暂停全部自动后台活动，配额恢复后自动解除。
 */
export function createModelQuotaGuard({
  rpc,
  config = () => ({}),
  cacheMs = 120_000,
  now = Date.now,
} = {}) {
  let cachedAt = 0
  let lastState = null
  let cachedConfig = ''

  async function check({ fresh = false } = {}) {
    const cfg = config() ?? {}
    const modelsCfg = normalizeModels(cfg.models)
    const key = JSON.stringify(modelsCfg)
    if (modelsCfg.minQuotaPercent <= 0) {
      lastState = evaluateModelQuota(null, modelsCfg)
      cachedConfig = key
      cachedAt = now()
      return lastState
    }
    const t = now()
    if (!fresh && lastState && t - cachedAt < cacheMs && cachedConfig === key) {
      return lastState
    }
    if (!rpc?.available?.() || typeof rpc.getModelCatalog !== 'function') {
      lastState = evaluateModelQuota(null, modelsCfg)
      cachedConfig = key
      cachedAt = t
      return lastState
    }
    try {
      const catalog = await rpc.getModelCatalog()
      lastState = evaluateModelQuota(catalog, modelsCfg)
      cachedConfig = key
      cachedAt = now()
      return lastState
    } catch {
      return (cachedConfig === key ? lastState : null) ?? evaluateModelQuota(null, modelsCfg)
    }
  }

  return {
    check,
    invalidate() {
      cachedAt = 0
      lastState = null
      cachedConfig = ''
    },
    status() {
      const cfg = config() ?? {}
      const modelsCfg = normalizeModels(cfg.models)
      if (modelsCfg.minQuotaPercent <= 0) return evaluateModelQuota(null, modelsCfg)
      if (lastState && cachedConfig === JSON.stringify(modelsCfg)) return lastState
      return evaluateModelQuota(null, modelsCfg)
    },
  }
}
