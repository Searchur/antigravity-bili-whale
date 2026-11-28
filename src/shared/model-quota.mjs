/**
 * 前后端共享的模型档位匹配、名称格式化与配额保护判定。
 */
import { belowQuotaThreshold, remainingQuotaPercent } from './quota-percentage.mjs'

const THINKING_LABELS = new Map([
  ['low', 'Low'], ['medium', 'Medium'], ['high', 'High'], ['xhigh', 'Extra High'],
])

export const modelThinkingLabel = model => THINKING_LABELS.get(model.thinkingLevel) ?? model.thinkingLabel ?? ''

export function formatModelTitle(model) {
  const thinking = modelThinkingLabel(model)
  if (model.groupName && thinking && thinking !== '默认') return `${model.groupName} · ${thinking}`
  return model.groupName || model.label || model.id
}

export function findCatalogModel(catalog, id) {
  if (!id || !Array.isArray(catalog?.models)) return null
  return catalog.models.find(model => model?.id === id && model.groupKey !== 'auto-tier') ?? null
}

export function sameModelQuotaConfig(left, right) {
  return left?.main === right?.main && left?.worker === right?.worker
    && left?.minQuotaPercent === right?.minQuotaPercent
}

// 只比较已选档位的已知配额，有效的零配额也参与比较。
export function evaluateSelectedModelQuota(catalog, { main, worker, minQuotaPercent: threshold }) {
  const enabled = threshold > 0
  let model = null
  if (enabled && catalog?.source === 'live') {
    for (const id of new Set([main, worker])) {
      const selected = findCatalogModel(catalog, id)
      if (Number.isFinite(selected?.remainingFraction) && (!model || selected.remainingFraction < model.remainingFraction)) {
        model = selected
      }
    }
  }
  const remainingPercent = model ? remainingQuotaPercent(model.remainingFraction) : null
  const modelLabel = model ? formatModelTitle(model) : ''
  const paused = model !== null && belowQuotaThreshold(model.remainingFraction, threshold)
  return {
    enabled, paused, threshold,
    selection: { main, worker },
    remainingPercent,
    modelId: model?.id ?? main,
    modelLabel,
    resetTime: model?.resetTime || null,
    reason: paused
      ? `模型「${modelLabel}」剩余配额 ${remainingPercent}% 低于保护阈值 ${threshold}%，已暂停全部后台活动。`
      : '',
  }
}
