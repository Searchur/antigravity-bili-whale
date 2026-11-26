import { normalizeModels } from '../tools/lib/config.mjs'

function pickLiveModel(catalog, modelId) {
  const live = (catalog?.models ?? []).filter(
    m => m && m.groupKey !== 'auto-tier' && typeof m.remainingFraction === 'number' && !Number.isNaN(m.remainingFraction),
  )
  if (!live.length) return null
  const exact = live.find(m => m.id === modelId)
  if (exact) return exact

  // 自适应档位（flash / flash_lite / pro）按命名启发式映射至对应实时模型配额
  const id = String(modelId || '').toLowerCase()
  if (id === 'flash_lite') {
    return live.find(m => /lite|mini|flash/i.test(`${m.id} ${m.label}`)) || live[0]
  }
  if (id === 'flash') {
    return live.find(m => /flash|hydrogen|carbon/i.test(`${m.id} ${m.label}`)) || live[0]
  }
  if (id === 'pro') {
    return live.find(m => /pro|neon|opus|sonnet/i.test(`${m.id} ${m.label}`)) || live[0]
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
  const hit = pickLiveModel(catalog, cfg.main) || pickLiveModel(catalog, cfg.worker)
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
  const remainingPercent = Math.max(0, Math.min(100, Math.round(hit.remainingFraction * 100)))
  const modelLabel = hit.groupName
    ? (hit.thinkingLabel && hit.thinkingLabel !== '默认' ? `${hit.groupName} · ${hit.thinkingLabel}` : hit.groupName)
    : (hit.label || hit.id)
  const paused = remainingPercent < threshold
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

  async function check({ fresh = false } = {}) {
    const cfg = config() ?? {}
    const modelsCfg = normalizeModels(cfg.models)
    if (modelsCfg.minQuotaPercent <= 0) {
      lastState = evaluateModelQuota(null, modelsCfg)
      cachedAt = now()
      return lastState
    }
    const t = now()
    if (!fresh && lastState && t - cachedAt < cacheMs && lastState.threshold === modelsCfg.minQuotaPercent && lastState.enabled) {
      return lastState
    }
    if (!rpc?.available?.() || typeof rpc.getModelCatalog !== 'function') {
      lastState = evaluateModelQuota(null, modelsCfg)
      cachedAt = t
      return lastState
    }
    try {
      const catalog = await rpc.getModelCatalog()
      lastState = evaluateModelQuota(catalog, modelsCfg)
      cachedAt = now()
      return lastState
    } catch {
      return lastState ?? evaluateModelQuota(null, modelsCfg)
    }
  }

  return {
    check,
    invalidate() {
      cachedAt = 0
      lastState = null
    },
    status() {
      const cfg = config() ?? {}
      const modelsCfg = normalizeModels(cfg.models)
      if (modelsCfg.minQuotaPercent <= 0) return evaluateModelQuota(null, modelsCfg)
      if (lastState && lastState.threshold === modelsCfg.minQuotaPercent) return lastState
      return evaluateModelQuota(null, modelsCfg)
    },
  }
}
