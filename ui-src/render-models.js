import { el, getPath } from './render-sections.js'

function findModel(catalog, id) {
  const list = catalog?.models ?? []
  return list.find(m => m.id === id) || null
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
  const pct = Math.max(0, Math.min(100, Math.round(fraction * 100)))
  const fillCls = pct <= 20 ? 'low' : pct <= 50 ? 'mid' : ''
  return el('span', { className: 'quota-wrap', title: `当前剩余配额约 ${pct}%` },
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
          ? el('span', { className: `model-tag ${tagClass(group.tagTitle)}`.trim(), title: group.tagDescription || '' }, group.tagTitle)
          : null,
        !isAuto && group.supportsImages
          ? el('span', { className: 'model-tag ok' }, '支持看图')
          : null),
      !isAuto ? renderQuota(group.remainingFraction) : null),
    group.tagDescription
      ? el('div', { className: 'model-desc' }, group.tagDescription)
      : null,
    el('div', { className: 'effort-row' },
      el('span', { className: 'effort-label' }, isAuto ? '选择档位：' : 'Thinking 强度 / 规格：'),
      ...(group.variants ?? []).map((v) => {
        const isCurrent = v.id === activeId
        const isOther = v.id === otherId && otherId !== activeId
        const cls = ['effort-btn', isCurrent ? 'active' : '', isOther ? 'other-role' : ''].filter(Boolean).join(' ')
        return el('button', {
          type: 'button',
          className: cls,
          title: `${v.label}（${v.id}）`,
          onClick: () => onPick(activeRole, v.id),
        },
        isCurrent ? '✓ ' : null,
        v.thinkingLabel || v.label,
        isOther ? el('span', { className: 'effort-badge' }, otherLabel) : null)
      })))
}

/**
 * 独立「模型选择」页签：
 * - 实时读取当前 Antigravity 可用模型列表（含完整家族、Thinking 强度、标签与实时配额）。
 * - 仅支持点击选择，不提供容易写错的手打输入框。
 */
export function renderModelsTab(state, actions) {
  const cfg = state.cfg
  const catalog = state.modelCatalog
  const mainId = getPath(cfg, ['models', 'main']) || 'flash'
  const workerId = getPath(cfg, ['models', 'worker']) || 'flash_lite'
  const activeRole = state.modelRole === 'worker' ? 'worker' : 'main'
  const isLive = catalog?.source === 'live'
  const groups = catalog?.groups ?? []
  const autoGroups = groups.filter(g => g.key === 'auto-tier')
  const liveGroups = groups.filter(g => g.key !== 'auto-tier')

  const activeId = activeRole === 'main' ? mainId : workerId
  const missingInCatalog = isLive && activeId && !findModel(catalog, activeId)

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

  return el('div', {},
    el('div', { className: 'card' },
      el('div', { className: 'card-head' },
        el('div', { className: 'inline' },
          el('h2', {}, 'Antigravity 内置模型选择'),
          isLive
            ? el('span', { className: 'pill ok' }, el('span', { className: 'dot' }), `已读取 ${catalog.liveCount} 个实时模型档位`)
            : el('span', { className: 'pill warn' }, el('span', { className: 'dot' }), '自适应档位模式')),
        el('button', {
          type: 'button',
          className: 'btn',
          disabled: !!state.busy,
          onClick: actions.refreshModels,
        }, state.busy === 'models' ? '读取中…' : '刷新模型列表')),
      el('p', { className: 'card-sub' }, '全程仅使用当前 Antigravity 内置模型，无需任何外部 API Key。先点选上方要配置的角色，再在下方直接点击模型档位即可（记得点击右上角「保存配置」生效）。'),
      el('div', { className: 'role-grid' },
        roleCard('main', '前台主线模型', '负责刷视频、看画面、聊私信与评论互动（建议均衡或高表现模型）', mainId),
        roleCard('worker', '后台 Worker 模型', '负责记忆归纳、心情、日记与社交判断，运行完自动归档（建议省配额轻量模型）', workerId)),
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
        : null))
}
