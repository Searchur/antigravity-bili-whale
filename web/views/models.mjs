/**
 * Tab 3 视图（模型与配额）：渲染 Antigravity 内置模型清单、用途切换、剩余配额保护与会话轮换设置。
 */
import { el, getPath, row, selectCtrl, metaPill, banner } from './sections.mjs'
import {
  evaluateSelectedModelQuota, findCatalogModel, formatModelTitle, formatRemainingQuota, isKnownQuotaFraction,
  modelQuotaGroupId, modelThinkingLabel, MODEL_QUOTA_GROUP_NAMES, sameModelQuotaConfig,
} from '../../src/shared/model-quota.mjs'

const LEGACY_PRESETS = new Set(['flash', 'flash_lite', 'pro'])
const PERIOD_LABELS = { weekly: '周额度', 'five-hour': '五小时额度' }
const quotaClock = new Intl.DateTimeFormat('zh-CN', {
  month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false,
})

function tagClass(tagTitle) {
  const t = String(tagTitle || '').toLowerCase()
  if (t.includes('new') || t.includes('推荐')) return 'new'
  if (t.includes('leaving') || t.includes('soon') || t.includes('notice')) return 'warn'
  return ''
}

function formatQuotaTime(value) {
  const time = Date.parse(value)
  return Number.isFinite(time) ? quotaClock.format(time) : ''
}

function renderUsageWindow(window) {
  const reset = !window.disabled && formatQuotaTime(window.resetTime)
  let value = '配额未返回'
  if (window.disabled) value = '不适用'
  else if (isKnownQuotaFraction(window.remainingFraction)) value = formatRemainingQuota(window.remainingFraction)
  return el('div', { className: 'model-usage-window' },
    el('dt', {}, PERIOD_LABELS[window.period]),
    el('dd', {},
      el('span', { className: 'model-usage-value' }, value),
      reset ? el('time', { className: 'row-hint', datetime: window.resetTime }, `${reset} 重置`) : null))
}

function renderModelUsage(usage, loading) {
  const ready = usage?.state === 'ready'
  const time = ready ? formatQuotaTime(usage.checkedAt) : ''
  const message = loading ? '正在读取用量…' : time ? `${time} 已更新` : '用量未更新'
  return el('section', { className: 'model-usage' },
    el('div', { className: 'model-usage-head' },
      el('h3', { className: 'model-section-title' }, '模型组用量'),
      el('span', { className: 'row-hint', role: 'status' }, message)),
    ready ? el('div', { className: 'model-usage-grid' }, ...usage.groups.map(group =>
      el('div', { className: 'model-usage-group' },
        el('h4', {}, group.name),
        el('dl', {}, ...group.windows.map(renderUsageWindow))))) : null)
}

function renderGroupCard(group, { activeRole, mainId, workerId, onPick }) {
  const activeId = activeRole === 'main' ? mainId : workerId
  const otherId = activeRole === 'main' ? workerId : mainId
  const otherLabel = activeRole === 'main' ? '后台辅助模型' : '前台主线模型'
  const variants = group.variants ?? []
  const activeVariant = variants.find(v => v.id === activeId)
  const quotaGroup = modelQuotaGroupId(variants[0])
  const groupLabel = quotaGroup && variants.every(v => modelQuotaGroupId(v) === quotaGroup)
    ? MODEL_QUOTA_GROUP_NAMES[quotaGroup]
    : null

  return el('div', { className: 'model-group' + (activeVariant ? ' has-active' : '') },
    el('span', { className: 'model-name' }, group.name),
    el('div', { className: 'model-tags' },
      group.tagTitle
        ? el('span', { className: `model-tag ${tagClass(group.tagTitle)}`.trim() },
            el('span', { className: 'model-control-label' }, group.tagTitle))
        : null,
      group.supportsImages ? el('span', { className: 'model-tag ok' }, '支持看图') : null),
    el('div', { className: 'effort-row', role: 'group', 'aria-label': `${group.name}的思考强度或规格` },
      ...variants.map(v => {
        const isCurrent = v.id === activeId
        const isOther = v.id === otherId && otherId !== activeId
        const cls = ['effort-btn', isCurrent ? 'active' : '', isOther ? 'other-role' : ''].filter(Boolean).join(' ')
        const label = modelThinkingLabel(v) || v.label || v.id
        const description = isOther ? `${label}，${otherLabel}已选` : label
        return el('button', {
          type: 'button',
          className: cls,
          'data-model-control': `variant:${v.id}`,
          'aria-label': description,
          'aria-pressed': String(isCurrent),
          onClick: () => onPick(activeRole, v.id),
        },
        el('span', { className: 'model-control-label' }, label))
      })),
    el('div', { className: 'model-quota' }, groupLabel))
}

/**
 * Tab 3：模型与配额（含剩余配额保护阈值与会话轮换周期）
 */
export function renderModelsTab(state, actions) {
  const cfg = state.cfg
  const catalog = state.modelCatalog
  const mainId = getPath(cfg, ['models', 'main']) || ''
  const workerId = getPath(cfg, ['models', 'worker']) || ''
  const minQuotaChoices = [0, 10, 20, 30, 40, 50]
  const rawMinQuota = Number(getPath(cfg, ['models', 'minQuotaPercent']) ?? 20)
  const minQuotaVal = Number.isFinite(rawMinQuota) ? Math.max(0, Math.min(80, Math.floor(rawMinQuota))) : 20
  const minQuotaOptions = [
    ['0', '不限制'],
    ['10', '低于 10% 时暂停全部后台活动'],
    ['20', '低于 20% 时暂停全部后台活动（默认）'],
    ['30', '低于 30% 时暂停全部后台活动'],
    ['40', '低于 40% 时暂停全部后台活动'],
    ['50', '低于 50% 时暂停全部后台活动'],
  ]
  if (!minQuotaChoices.includes(minQuotaVal)) {
    minQuotaOptions.push([String(minQuotaVal), `低于 ${minQuotaVal}% 时暂停全部后台活动（自定义）`])
  }
  const activeRole = state.modelRole === 'worker' ? 'worker' : 'main'
  const isLive = catalog?.source === 'live'
  const liveGroups = (catalog?.groups ?? []).filter(g => g.key !== 'auto-tier')
  const mainModel = findCatalogModel(catalog, mainId)
  const workerModel = findCatalogModel(catalog, workerId)

  const activeId = activeRole === 'main' ? mainId : workerId
  const activeModel = activeRole === 'main' ? mainModel : workerModel
  const missingInCatalog = isLive && !activeModel
  const rawRotate = Number(getPath(cfg, ['sessionRotateDays']) ?? 7)
  const rotateChoices = [0, 3, 7, 14, 30]
  const rotateVal = Number.isFinite(rawRotate) ? Math.max(0, Math.min(365, Math.floor(rawRotate))) : 7
  const rotateOptions = [
    ['0', '不自动轮换'],
    ['3', '每 3 天轮换一次'],
    ['7', '每 7 天轮换一次（默认）'],
    ['14', '每 14 天轮换一次'],
    ['30', '每 30 天轮换一次'],
  ]
  if (!rotateChoices.includes(rotateVal)) {
    rotateOptions.push([String(rotateVal), `每 ${rotateVal} 天轮换一次（自定义）`])
  }

  const selection = { main: mainId, worker: workerId, minQuotaPercent: minQuotaVal }
  const isDraft = !sameModelQuotaConfig(selection, state.savedCfg?.models)
  const preview = evaluateSelectedModelQuota(catalog, selection)
  const serverQuota = state.status?.modelQuota
  const confirmedPause = !isDraft && minQuotaVal > 0 && serverQuota?.paused
    && serverQuota.checkedAt && serverQuota.checkedAt === catalog?.usage?.checkedAt
    && [mainId, workerId].includes(serverQuota.modelId)
    && sameModelQuotaConfig(selection, { ...serverQuota.selection, minQuotaPercent: serverQuota.threshold })
  let quotaBannerText = ''
  if (confirmedPause && serverQuota.reason) {
    quotaBannerText = serverQuota.reason
  } else if (preview.paused) {
    const ending = isDraft ? '，保存后将暂停全部后台活动。' : '。'
    quotaBannerText = `模型【${preview.modelLabel}】剩余配额 ${preview.remainingText} 低于保护阈值 ${minQuotaVal}%${ending}`
  }

  const roleCard = (role, title, desc, modelId, model) => {
    const selected = activeRole === role
    const needsSelection = !model && (!modelId || LEGACY_PRESETS.has(modelId))
    const modelTitle = model ? formatModelTitle(model) : needsSelection ? '待选择实际模型' : modelId
    return el('button', {
      type: 'button',
      className: 'role-card' + (selected ? ' active' : ''),
      'data-model-control': `role:${role}`,
      'aria-pressed': String(selected),
      onClick: () => actions.setModelRole(role),
    },
    el('span', { className: 'role-card-copy' },
      el('span', { className: 'role-card-top' },
        el('span', { className: 'role-card-title' }, title),
        selected ? metaPill('当前正在设置', 'info') : null),
      el('span', { className: 'role-card-desc' }, desc)),
    el('span', { className: 'role-card-selection' },
      el('span', { className: 'role-card-val' }, modelTitle),
      needsSelection ? null : el('span', { className: 'role-card-id mono' }, modelId)))
  }

  const sessionCard = el('div', { className: 'card' },
    el('h2', {}, '配额保护与会话轮换'),
    el('p', { className: 'card-sub' }, '设置剩余配额保护阈值以避免耗尽 Antigravity 配额；定期轮换新会话可控制上下文开销，长期记忆自动续接。'),
    row(
      '配额保护阈值',
      '按前台和后台所选模型的配额组，取适用周期中较低的已知配额。低于阈值时暂停全部后台活动，配额恢复后自动解除。',
      selectCtrl(
        String(minQuotaVal),
        minQuotaOptions,
        v => actions.setCfg(['models', 'minQuotaPercent'], Number(v), true),
      )),
    row(
      '会话自动轮换周期',
      '每隔指定天数在空闲时自动新建会话以控制上下文长度；选择【不自动轮换】则持续复用同一会话。',
      selectCtrl(
        String(rotateVal),
        rotateOptions,
        v => actions.setCfg(['sessionRotateDays'], Number(v), true),
      )))

  return el('div', {},
    el('div', { className: 'card' },
      el('div', { className: 'card-head' },
        el('h2', {}, '内置模型选择'),
        el('button', {
          type: 'button',
          className: 'btn',
          disabled: !!state.busy,
          onClick: () => actions.refreshModels(true),
        }, state.busy === 'models' ? '读取中…' : '刷新模型列表')),
      el('p', { className: 'card-sub' }, '选择要设置的用途和模型档位，再点击【保存配置】生效。'),
      quotaBannerText ? banner('warn', quotaBannerText) : null,
      el('div', { className: 'role-grid' },
        roleCard('main', '前台主线模型', '负责视频观看、画面理解、私信对话与评论互动；建议选择均衡或高性能模型。', mainId, mainModel),
        roleCard('worker', '后台辅助模型', '负责长期记忆归纳、心情分析与外发安全语义复审，运行后自动归档；建议选择低消耗轻量模型。', workerId, workerModel)),
      !isLive && !state.modelsError && state.busy !== 'models'
        ? banner('warn', catalog?.note || '请确认后台守护已启动，再点击【刷新模型列表】。')
        : null,
      state.modelsError
        ? banner('err', state.modelsError)
        : null,
      renderModelUsage(catalog?.usage, state.busy === 'models'),
      missingInCatalog
        ? banner('warn', !activeId || LEGACY_PRESETS.has(activeId)
          ? '请从下方清单为当前用途选择一个模型档位并保存。'
          : `当前已保存的模型【${activeId}】不在本次读取的可用清单中，请在下方重新点选。`)
        : null,
      liveGroups.length > 0 ? el('h3', { className: 'model-section-title' }, '当前完整模型清单') : null,
      liveGroups.length > 0
        ? el('div', { className: 'model-list' }, ...liveGroups.map(g => renderGroupCard(g, {
            activeRole, mainId, workerId, onPick: actions.selectModel,
          })))
        : null),
    sessionCard)
}
