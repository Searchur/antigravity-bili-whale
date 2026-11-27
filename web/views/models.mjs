import { el, getPath, row, selectCtrl } from './sections.mjs'
import { belowQuotaThreshold, remainingQuotaPercent } from '../../src/shared/quota-percentage.mjs'

const LIGHT_MODEL_RE = /(?:^|[^a-z0-9])(?:lite|mini)(?:$|[^a-z0-9])|flashlite/i

function findModel(catalog, id) {
  const list = catalog?.models ?? []
  return list.find(m => m.id === id) || null
}

function resolveQuotaModel(catalog, modelId) {
  const live = (catalog?.models ?? []).filter(
    m => m && m.groupKey !== 'auto-tier' && typeof m.remainingFraction === 'number' && !Number.isNaN(m.remainingFraction),
  )
  if (!live.length) return null
  const exact = live.find(m => m.id === modelId)
  if (exact) return exact
  const id = String(modelId || '').toLowerCase()
  if (id === 'flash_lite') {
    return live.find(m => LIGHT_MODEL_RE.test(`${m.id} ${m.label}`)) || null
  }
  if (id === 'flash') {
    return live.find(m => /flash|hydrogen|carbon/i.test(`${m.id} ${m.label}`) && !LIGHT_MODEL_RE.test(`${m.id} ${m.label}`)) || null
  }
  if (id === 'pro') {
    return live.find(m => /pro|neon|opus|sonnet/i.test(`${m.id} ${m.label}`)) || null
  }
  return null
}

function formatModelTitle(catalog, id) {
  const m = findModel(catalog, id)
  if (!m) return id || '未选择'
  if (m.groupKey === 'auto-tier') return m.label
  if (m.thinkingLabel && m.thinkingLabel !== '默认') return `${m.groupName} · ${m.thinkingLabel}`
  return m.label || m.groupName
}

function tagClass(tagTitle) {
  const t = String(tagTitle || '').toLowerCase()
  if (t.includes('new') || t.includes('推荐') || t.includes('自适应')) return 'new'
  if (t.includes('leaving') || t.includes('soon') || t.includes('notice')) return 'warn'
  return ''
}

function renderQuota(fraction) {
  if (typeof fraction !== 'number' || Number.isNaN(fraction)) return null
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
  const hasActive = (group.variants ?? []).some(v => v.id === activeId)
  const isAuto = group.key === 'auto-tier'

  return el('div', { className: 'model-group' + (hasActive ? ' has-active' : '') },
    el('div', { className: 'model-head' },
      el('div', { className: 'model-title-wrap' },
        el('span', { className: 'model-name' }, group.name),
        group.tagTitle
          ? el('span', { className: `model-tag ${tagClass(group.tagTitle)}`.trim() }, group.tagTitle)
          : null,
        !isAuto && group.supportsImages
          ? el('span', { className: 'model-tag ok' }, '支持看图')
          : null),
      !isAuto ? renderQuota(group.remainingFraction) : null),
    el('div', { className: 'effort-row' },
      el('span', { className: 'effort-label' }, isAuto ? '选择档位：' : 'Thinking 强度 / 规格：'),
      ...(group.variants ?? []).map((v) => {
        const isCurrent = v.id === activeId
        const isOther = v.id === otherId && otherId !== activeId
        const cls = ['effort-btn', isCurrent ? 'active' : '', isOther ? 'other-role' : ''].filter(Boolean).join(' ')
        return el('button', {
          type: 'button',
          className: cls,
          onClick: () => onPick(activeRole, v.id),
        },
        v.thinkingLabel || v.label,
        isOther ? el('span', { className: 'effort-badge' }, otherLabel) : null)
      })))
}

/**
 * Tab 3：模型选择（含剩余配额保护阈值与会话轮换周期）
 */
export function renderModelsTab(state, actions) {
  const cfg = state.cfg
  const catalog = state.modelCatalog
  const mainId = getPath(cfg, ['models', 'main']) || 'flash'
  const workerId = getPath(cfg, ['models', 'worker']) || 'flash_lite'
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
  const groups = catalog?.groups ?? []
  const autoGroups = groups.filter(g => g.key === 'auto-tier')
  const liveGroups = groups.filter(g => g.key !== 'auto-tier')

  const activeId = activeRole === 'main' ? mainId : workerId
  const missingInCatalog = isLive && activeId && !findModel(catalog, activeId)
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

  const mainLive = isLive ? resolveQuotaModel(catalog, mainId) : null
  const workerLive = isLive ? resolveQuotaModel(catalog, workerId) : null
  const lowHit = workerLive && (!mainLive || workerLive.remainingFraction < mainLive.remainingFraction)
    ? { role: '后台 Worker 模型', model: workerLive }
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
      ? `当前${lowHit.role}（${formatModelTitle(catalog, lowHit.model.id)}）剩余配额 ${lowQuotaPct}% 低于保护阈值 ${minQuotaVal}%，保存后将暂停全部自动后台活动，待配额恢复后自动解除。`
      : '')

  const roleCard = (role, title, desc, modelId) => {
    const selected = activeRole === role
    return el('button', {
      type: 'button',
      className: 'role-card' + (selected ? ' active' : ''),
      onClick: () => actions.setModelRole(role),
    },
    el('div', { className: 'role-card-top' },
      el('span', { className: 'role-card-title' }, title),
      el('span', { className: 'pill ' + (selected ? 'info' : '') }, selected ? '当前正在设置' : '点击切换设置')),
    el('div', { className: 'role-card-desc' }, desc),
    el('div', { className: 'role-card-val' }, formatModelTitle(catalog, modelId)),
    el('div', { className: 'role-card-id mono' }, modelId))
  }

  const sessionCard = el('div', { className: 'card' },
    el('h2', {}, '配额保护与会话轮换'),
    el('p', { className: 'card-sub' }, '设置剩余配额保护红线避免把 Antigravity 额度耗尽；定期轮换新会话可控制长对话上下文开销，长期记忆无缝续接。'),
    row(
      '模型剩余配额低于多少不再活动',
      '当所选模型剩余配额低于设定比例时，自动暂停看视频、私信/评论自动回复及后台归纳等全部活动，配额恢复后自动恢复运行。',
      selectCtrl(
        String(minQuotaVal),
        minQuotaOptions,
        v => actions.setCfg(['models', 'minQuotaPercent'], Number(v), true),
      )),
    row(
      '自动轮换新会话周期',
      '每过指定天数趁大鲸鱼空闲时自动开一个干净新会话；选「不自动轮换」则持续复用同一会话。',
      selectCtrl(
        String(rotateVal),
        rotateOptions,
        v => actions.setCfg(['sessionRotateDays'], Number(v), true),
      )))

  return el('div', {},
    el('div', { className: 'card' },
      el('div', { className: 'card-head' },
        el('div', { className: 'inline' },
          el('h2', {}, 'Antigravity 内置模型选择'),
          isLive
            ? el('span', { className: 'pill ok' }, el('span', { className: 'dot' }), `已读取 ${catalog.liveCount} 个实时模型档位`)
            : el('span', { className: 'pill warn' }, el('span', { className: 'dot' }), '自适应档位模式'),
          quotaPausedNow
            ? el('span', { className: 'pill warn' }, el('span', { className: 'dot' }), '配额保护已暂停活动')
            : null),
        el('button', {
          type: 'button',
          className: 'btn',
          disabled: !!state.busy,
          onClick: actions.refreshModels,
        }, state.busy === 'models' ? '读取中…' : '刷新模型列表')),
      el('p', { className: 'card-sub' }, '全程仅使用当前 Antigravity 内置模型，无需外部 API Key。先点选上方要配置的角色，再在下方直接点击模型档位即可（记得点右上角「保存配置」）。'),
      quotaBannerText ? el('div', { className: 'banner warn' }, quotaBannerText) : null,
      el('div', { className: 'role-grid' },
        roleCard('main', '前台主线模型', '负责刷视频、看画面、聊私信与评论互动（建议均衡或高表现模型）', mainId),
        roleCard('worker', '后台 Worker 模型', '负责记忆归纳与外发内容安全语义复审，运行完自动归档（建议省配额轻量模型）', workerId)),
      !isLive && catalog?.note
        ? el('div', { className: 'banner warn' }, `${catalog.note}。后台守护启动后点击右上角「刷新模型列表」即可拉取完整清单。`)
        : null,
      state.modelsError
        ? el('div', { className: 'banner err' }, state.modelsError)
        : null,
      missingInCatalog
        ? el('div', { className: 'banner warn' }, `当前已保存的模型「${activeId}」不在本次读取的可用清单中，请在下方重新点选。`)
        : null,
      autoGroups.length > 0 ? el('div', { className: 'model-section-title' }, '自适应档位（推荐 · 随 Antigravity 自动映射）') : null,
      autoGroups.length > 0
        ? el('div', { className: 'model-list' }, ...autoGroups.map(g => renderGroupCard(g, {
            activeRole, mainId, workerId, onPick: actions.selectModel,
          })))
        : null,
      liveGroups.length > 0 ? el('div', { className: 'model-section-title' }, `当前 Antigravity 完整模型清单（${liveGroups.length} 个模型家族 · 点击 Thinking 强度即选）`) : null,
      liveGroups.length > 0
        ? el('div', { className: 'model-list' }, ...liveGroups.map(g => renderGroupCard(g, {
            activeRole, mainId, workerId, onPick: actions.selectModel,
          })))
        : null),
    sessionCard)
}
