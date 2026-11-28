/**
 * 模型剩余配额守卫：评估所选模型配额是否低于保护阈值，提供带缓存的自动暂停/恢复判定。
 */
import { normalizeModels } from '../config/index.mjs'
import { evaluateSelectedModelQuota, sameModelQuotaConfig } from '../shared/model-quota.mjs'

/**
 * 评估当前所选模型剩余配额是否低于用户设置的保护阈值。
 */
export function evaluateModelQuota(catalog, rawModelCfg) {
  return evaluateSelectedModelQuota(catalog, normalizeModels(rawModelCfg))
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
  const readModelConfig = () => normalizeModels(config()?.models)
  let cached = null
  let revision = 0

  function remember(catalog, models) {
    const status = evaluateSelectedModelQuota(catalog, models)
    cached = { models, status, checkedAt: now() }
    return status
  }

  async function check({ fresh = false } = {}) {
    for (;;) {
      const models = readModelConfig()
      if (models.minQuotaPercent <= 0) return remember(null, models)
      if (!fresh && cached && sameModelQuotaConfig(cached.models, models) && now() - cached.checkedAt < cacheMs) {
        return cached.status
      }
      if (!rpc?.available?.() || typeof rpc.getModelCatalog !== 'function') return remember(null, models)

      const requestRevision = revision
      let catalog
      let failed = false
      try { catalog = await rpc.getModelCatalog() } catch { failed = true }
      // 读配额期间保存了配置时，重新按当前档位判断，丢弃旧结果。
      if (requestRevision !== revision || !sameModelQuotaConfig(models, readModelConfig())) {
        fresh = false
        continue
      }
      if (failed) {
        return cached && sameModelQuotaConfig(cached.models, models)
          ? cached.status
          : evaluateSelectedModelQuota(null, models)
      }
      return remember(catalog, models)
    }
  }

  return {
    check,
    invalidate() {
      revision++
      cached = null
    },
    status() {
      const models = readModelConfig()
      return cached && sameModelQuotaConfig(cached.models, models)
        ? cached.status
        : evaluateSelectedModelQuota(null, models)
    },
  }
}
