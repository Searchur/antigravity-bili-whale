/**
 * Tab 3 视图（模型与配额）：渲染 Antigravity 内置模型清单、用途切换、剩余配额保护与会话轮换设置。
 */
import { el, getPath, row, selectCtrl, statusPill, metaPill, banner } from './sections.mjs'
import { belowQuotaThreshold, remainingQuotaPercent } from '../../src/shared/quota-percentage.mjs'

const LEGACY_PRESETS = new Set(['flash', 'flash_lite', 'pro'])

function findModel(catalog, id) {
  const list = catalog?.models ?? []
  return list.find(m => m.groupKey !== 'auto-tier' && m.id === id) || null
}

function formatModelTitle(m) {
  if (m.thinkingLabel && m.thinkingLabel !== '默认') return `${m.groupName} · ${m.thinkingLabel}`
  return m.label || m.groupName
}

function tagClass(tagTitle) {
  const t = String(tagTitle || '').toLowerCase()
  if (t.includes('new') || t.includes('推荐')) return 'new'
  if (t.includes('leaving') || t.includes('soon') || t.includes('notice')) return 'warn'
  return ''
}

function renderQuota(fraction) {
  if (!Number.isFinite(fraction)) return el('span', { className: 'quota-wrap' }, '配额未返回')
  const pct = remainingQuotaPercent(fraction)
  const fillCls = pct <= 20 ? 'low' : pct <= 50 ? 'mid' : ''
  return el('span', { className: 'quota-wrap' },
    el('span', { className: 'quota-bar' },
      el('span', { className: `quota-fill ${fillCls}`.trim(), style: { width: `${pct}%` } })),
    `剩余 ${pct}%`)
}

function renderGroupCard(group, { activeRole, mainId, workerId, onPick }) {
  const activeId = activeRole === 'main' ? mainId : workerId
  const otherId = activeRole === 'main' ? workerId : mainId
  const otherLabel = activeRole === 'main' ? '后台' : '主线'
  const variants = group.variants ?? []
  const activeVariant = variants.find(v => v.id === activeId)
  const groupFraction = group.remainingFraction ?? null
  const quotaVaries = variants.some(v => (v.remainingFraction ?? null) !== groupFraction)

  return el('div', { className: 'model-group' + (activeVariant ? ' has-active' : '') },
    el('div', { className: 'model-head' },
      el('div', { className: 'model-title-wrap' },
        el('span', { className: 'model-name' }, group.name),
        group.tagTitle
          ? el('span', { className: `model-tag ${tagClass(group.tagTitle)}`.trim() }, group.tagTitle)
          : null,
        group.supportsImages
          ? el('span', { className: 'model-tag ok' }, '支持看图')
          : null),
      activeVariant || !quotaVaries ? renderQuota(activeVariant ? activeVariant.remainingFraction : groupFraction) : null),
    el('div', { className: 'effort-row' },
      el('span', { className: 'effort-label' }, 'Thinking 强度或规格'),
      ...variants.map(v => {
        const isCurrent = v.id === activeId
        const isOther = v.id === otherId && otherId !== activeId
        const cls = ['effort-btn', isCurrent ? 'active' : '', isOther ? 'other-role' : ''].filter(Boolean).join(' ')
        return el('button', {
          type: 'button',
          className: cls,
          onClick: () => onPick(activeRole, v.id),
        },
        v.thinkingLabel || v.label,
        quotaVaries ? el('span', { className: 'effort-badge' }, Number.isFinite(v.remainingFraction)
          ? `${remainingQuotaPercent(v.remainingFraction)}%` : '配额未返回') : null,
        isOther ? el('span', { className: 'effort-badge' }, otherLabel) : null)
      })))
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
  const minQuotaVal = Number.isFinite(rawMinQuota) ? Math.max(0, Math.min(95, Math.floor(rawMinQuota))) : 20
  const minQuotaOptions = [
    ['0', '不限制'],
    ['10', '低于 10% 时暂停全部活动'],
    ['20', '低于 20% 时暂停全部活动（默认）'],
    ['30', '低于 30% 时暂停全部活动'],
    ['40', '低于 40% 时暂停全部活动'],
    ['50', '低于 50% 时暂停全部活动'],
  ]
  if (!minQuotaChoices.includes(minQuotaVal)) {
    minQuotaOptions.push([String(minQuotaVal), `低于 ${minQuotaVal}% 时暂停全部活动（自定义）`])
  }
  const activeRole = state.modelRole === 'worker' ? 'worker' : 'main'
  const isLive = catalog?.source === 'live'
  const liveGroups = (catalog?.groups ?? []).filter(g => g.key !== 'auto-tier')
  const mainModel = findModel(catalog, mainId)
  const workerModel = findModel(catalog, workerId)

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

  const mainLive = isLive && Number.isFinite(mainModel?.remainingFraction) ? mainModel : null
  const workerLive = isLive && Number.isFinite(workerModel?.remainingFraction) ? workerModel : null
  const lowHit = workerLive && (!mainLive || workerLive.remainingFraction < mainLive.remainingFraction)
    ? { role: '后台辅助模型', model: workerLive }
    : (mainLive ? { role: '前台主线模型', model: mainLive } : null)
  const lowQuotaPct = lowHit
    ? remainingQuotaPercent(lowHit.model.remainingFraction)
    : null
  const serverQuota = state.status?.modelQuota
  const localBelow = minQuotaVal > 0 && lowHit !== null && belowQuotaThreshold(lowHit.model.remainingFraction, minQuotaVal)
  const quotaPausedNow = Boolean(serverQuota?.paused || localBelow)
  const quotaBannerText = serverQuota?.paused && serverQuota.reason
    ? serverQuota.reason
    : (localBelow
      ? `当前${lowHit.role}（${formatModelTitle(lowHit.model)}）剩余配额 ${lowQuotaPct}% 低于保护阈值 ${minQuotaVal}%，保存后将暂停全部自动后台活动，待配额恢复后自动解除。`
      : '')

  const roleCard = (role, title, desc, modelId, model) => {
    const selected = activeRole === role
    const needsSelection = !model && (!modelId || LEGACY_PRESETS.has(modelId))
    const modelTitle = model ? formatModelTitle(model) : needsSelection ? '待选择实际模型' : modelId
    return el('button', {
      type: 'button',
      className: 'role-card' + (selected ? ' active' : ''),
      onClick: () => actions.setModelRole(role),
    },
    el('div', { className: 'role-card-top' },
      el('span', { className: 'role-card-title' }, title),
      metaPill(selected ? '当前正在设置' : '点击切换设置', selected ? 'info' : '')),
    el('div', { className: 'role-card-desc' }, desc),
    el('div', { className: 'role-card-val' }, modelTitle),
    needsSelection ? null : el('div', { className: 'role-card-id mono' }, modelId))
  }

  const sessionCard = el('div', { className: 'card' },
    el('h2', {}, '配额保护与会话轮换'),
    el('p', { className: 'card-sub' }, '设置剩余配额保护阈值以避免耗尽 Antigravity 配额；定期轮换新会话可控制上下文开销，长期记忆自动续接。'),
    row(
      '配额保护阈值',
      '所选模型剩余配额低于该比例时，自动暂停视频观看、私信与评论自动回复及后台归纳等全部活动，配额恢复后自动解除。',
      selectCtrl(
        String(minQuotaVal),
        minQuotaOptions,
        v => actions.setCfg(['models', 'minQuotaPercent'], Number(v), true),
      )),
    row(
      '会话自动轮换周期',
      '每隔指定天数在空闲时自动新建会话以控制上下文长度；选择「不自动轮换」则持续复用同一会话。',
      selectCtrl(
        String(rotateVal),
        rotateOptions,
        v => actions.setCfg(['sessionRotateDays'], Number(v), true),
      )))

  return el('div', {},
    el('div', { className: 'card' },
      el('div', { className: 'card-head' },
        el('div', { className: 'inline' },
          el('h2', {}, '内置模型选择'),
          isLive
            ? statusPill('ok', `已读取 ${catalog.liveCount} 个实时模型档位`)
            : statusPill('warn', '未读取模型清单'),
          quotaPausedNow
            ? statusPill('warn', '配额保护已暂停')
            : null),
        el('button', {
          type: 'button',
          className: 'btn',
          disabled: !!state.busy,
          onClick: actions.refreshModels,
        }, state.busy === 'models' ? '读取中…' : '刷新模型列表')),
      el('p', { className: 'card-sub' }, '全程仅使用 Antigravity 内置模型，无需外部 API Key。先选择上方要配置的模型用途，再点击下方模型档位；修改后请点击右上角「保存配置」生效。'),
      quotaBannerText ? banner('warn', quotaBannerText) : null,
      el('div', { className: 'role-grid' },
        roleCard('main', '前台主线模型', '负责视频观看、画面理解、私信对话与评论互动；建议选择均衡或高性能模型。', mainId, mainModel),
        roleCard('worker', '后台辅助模型', '负责长期记忆归纳、心情分析与外发安全语义复审，运行后自动归档；建议选择低消耗轻量模型。', workerId, workerModel)),
      !isLive && !state.modelsError && state.busy !== 'models'
        ? banner('warn', catalog?.note || '请确认后台守护已启动，再点击「刷新模型列表」。')
        : null,
      state.modelsError
        ? banner('err', state.modelsError)
        : null,
      missingInCatalog
        ? banner('warn', !activeId || LEGACY_PRESETS.has(activeId)
          ? '请从下方清单为当前用途选择一个模型档位并保存。'
          : `当前已保存的模型「${activeId}」不在本次读取的可用清单中，请在下方重新点选。`)
        : null,
      liveGroups.length > 0 ? el('div', { className: 'model-section-title' }, `当前 Antigravity 完整模型清单（${liveGroups.length} 个模型家族 · 点击 Thinking 强度即选）`) : null,
      liveGroups.length > 0
        ? el('div', { className: 'model-list' }, ...liveGroups.map(g => renderGroupCard(g, {
            activeRole, mainId, workerId, onPick: actions.selectModel,
          })))
        : null),
    sessionCard)
}
