/**
 * 模型剩余配额守卫：评估所选模型配额是否低于保护阈值，提供带缓存的自动暂停/恢复判定。
 */
import { normalizeModels } from '../config/index.mjs'
import { evaluateSelectedModelQuota, sameModelQuotaConfig } from '../shared/model-quota.mjs'
import { fallbackModelCatalog } from './rpc.mjs'

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
  let lastLiveModels = null
  let revision = 0
  let latestRead = null

  function currentStatus(models) {
    return cached && sameModelQuotaConfig(cached.models, models) && now() - cached.readAt < cacheMs
      ? cached.status
      : null
  }

  async function readCatalog(forceRefresh) {
    if (!rpc?.available?.() || typeof rpc.getModelCatalog !== 'function') return fallbackModelCatalog()
    try {
      return await rpc.getModelCatalog({ forceRefresh }) ?? fallbackModelCatalog()
    } catch {
      return fallbackModelCatalog()
    }
  }

  function getCatalog({ forceRefresh = false } = {}) {
    if (latestRead?.revision === revision && latestRead.pending && (!forceRefresh || latestRead.forceRefresh)) {
      return latestRead.result
    }
    const read = { revision, forceRefresh, pending: true }
    latestRead = read
    read.result = readCatalog(forceRefresh).then(catalog => {
      read.pending = false
      // 强制刷新或配置更新后的读取优先，旧回包不会覆盖当前用量。
      if (read !== latestRead && latestRead.revision === revision) return latestRead.result
      if (read.revision !== revision) return getCatalog()
      const models = readModelConfig()
      if (catalog.source === 'live') lastLiveModels = catalog.models
      if (lastLiveModels && catalog.usage?.state === 'ready') {
        // 清单短时不可用时，用本会话上次确认的模型匹配刚取得的用量。
        const status = evaluateSelectedModelQuota({ source: 'live', models: lastLiveModels, usage: catalog.usage }, models)
        cached = { models, status, readAt: now() }
        return { ...catalog, modelQuota: status }
      }
      return { ...catalog, modelQuota: currentStatus(models) ?? evaluateSelectedModelQuota(null, models) }
    })
    return read.result
  }

  return {
    getCatalog,
    async check({ fresh = false } = {}) {
      const models = readModelConfig()
      if (models.minQuotaPercent <= 0) return evaluateSelectedModelQuota(null, models)
      const prior = fresh ? null : currentStatus(models)
      return prior ?? (await getCatalog()).modelQuota
    },
    invalidate() {
      revision++
      cached = null
    },
    status() {
      const models = readModelConfig()
      return currentStatus(models) ?? evaluateSelectedModelQuota(null, models)
    },
  }
}
