/**
 * 前后端共享的模型档位匹配、名称格式化与配额保护判定。
 */
import { belowQuotaThreshold, remainingQuotaPercent } from './quota-percentage.mjs'

const THINKING_LABELS = new Map([
  ['low', 'Low'], ['medium', 'Medium'], ['high', 'High'], ['xhigh', 'Extra High'],
])

export const MODEL_QUOTA_GROUP_NAMES = Object.freeze({ gemini: 'Gemini', 'claude-gpt': 'Claude 与 GPT' })

export const isKnownQuotaFraction = fraction => Number.isFinite(fraction) && fraction >= 0 && fraction <= 1

export function modelQuotaGroupId(model) {
  const id = String(model?.id ?? '').toLowerCase()
  if (model?.groupKey === 'orchestrator' || /^(?:gemini|orchestrator)-/.test(id)) return 'gemini'
  if (/^(?:claude-|(?:openai[-/])?gpt-oss-)/.test(id)) return 'claude-gpt'
  return null
}

export function formatRemainingQuota(fraction) {
  const percent = remainingQuotaPercent(fraction)
  return fraction > 0 && percent === 0 ? '不足 0.01%' : `${percent}%`
}

export const modelThinkingLabel = model => THINKING_LABELS.get(model.thinkingLevel) ?? model.thinkingLabel ?? ''

export function formatModelTitle(model) {
  const thinking = modelThinkingLabel(model)
  if (model.groupName && thinking && thinking !== '默认') return `${model.groupName}（${thinking}）`
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

// 按实际选中的档位定位共享配额组，各组只比较适用周期的已知用量。
export function evaluateSelectedModelQuota(catalog, { main, worker, minQuotaPercent: threshold }) {
  const enabled = threshold > 0
  const usage = catalog?.source === 'live' && catalog.usage?.state === 'ready' ? catalog.usage : null
  let minimum = null
  if (enabled && usage) {
    const visited = new Set()
    for (const id of [main, worker]) {
      const model = findCatalogModel(catalog, id)
      const groupId = modelQuotaGroupId(model)
      if (!groupId || visited.has(groupId)) continue
      visited.add(groupId)
      const group = usage.groups.find(item => item.id === groupId)
      for (const window of group?.windows ?? []) {
        const fraction = window.remainingFraction
        if (!window.disabled && isKnownQuotaFraction(fraction) && (!minimum || fraction < minimum.fraction)) {
          minimum = { model, fraction, resetTime: window.resetTime }
        }
      }
    }
  }
  const remainingPercent = minimum ? remainingQuotaPercent(minimum.fraction) : null
  const remainingText = minimum ? formatRemainingQuota(minimum.fraction) : ''
  const modelLabel = minimum ? formatModelTitle(minimum.model) : ''
  const paused = minimum !== null && belowQuotaThreshold(minimum.fraction, threshold)
  return {
    enabled, paused, threshold, checkedAt: usage?.checkedAt ?? null,
    selection: { main, worker },
    remainingPercent, remainingText,
    modelId: minimum?.model.id ?? main,
    modelLabel,
    resetTime: minimum?.resetTime ?? null,
    reason: paused
      ? `模型【${modelLabel}】剩余配额 ${remainingText} 低于保护阈值 ${threshold}%，已暂停全部后台活动。`
      : '',
  }
}
