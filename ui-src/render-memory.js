import { el, row } from './render-sections.js'

function workerPill(label, st) {
  const s = st?.status || 'idle'
  const cls = s === 'running' ? 'info' : s === 'error' ? 'err' : s === 'unavailable' ? 'warn' : 'ok'
  const txt = { idle: '待命', running: '运行中', error: '异常', unavailable: '未连接', disabled: '已关闭' }[s] || s
  return el('span', { className: `pill ${cls}` }, el('span', { className: 'dot' }), `${label}：${txt}`)
}

/**
 * Tab 6：动态与记忆（精简实用版）
 * - 整合今日活动概览（分享/评论/粉丝回复/作息计划/后台 Worker/暂停开关）与大鲸鱼长期记忆管理。
 * - 移除底层开发 JSON 调试按钮、手写 JSON 提案与外部 CSV 语料审核界面（内置表达参考在后台静默生效）。
 */
export function renderMemoryTab(state, actions) {
  const st = state.status ?? {}
  const life = state.lifeState
  const fq = st.fanQuota ?? {}
  const activeMemories = (life?.memories ?? []).filter(m => m.active)
  const searchResults = Array.isArray(state.lifeSearchItems) ? state.lifeSearchItems : null

  const activityCard = el('div', { className: 'card' },
    el('div', { className: 'card-head' },
      el('div', { className: 'inline' },
        el('h2', {}, '今日活动与运行概览'),
        life
          ? el('span', { className: 'pill ' + (life.paused ? 'warn' : 'ok') }, el('span', { className: 'dot' }), life.paused ? '主动活动已暂停' : '正常运行中')
          : null),
      el('div', { className: 'inline' },
        life
          ? el('button', {
              type: 'button',
              className: 'btn ' + (life.paused ? 'primary' : 'danger'),
              disabled: !!state.busy,
              onClick: () => actions.runLife('pause', { value: !life.paused }),
            }, life.paused ? '恢复主动活动' : '暂停主动活动')
          : null,
        el('button', { type: 'button', className: 'btn', disabled: !!state.busy, onClick: actions.refreshMemoryOverview }, '刷新概览'))),
    el('div', { className: 'grid-2' },
      el('div', { className: 'stat-tile' },
        el('div', { className: 'stat-k' }, '今日分享 / 发言'),
        el('div', { className: 'stat-v' }, `${st.shares ?? 0} / ${st.sharesMax ?? 3} 次分享 · ${st.commentsToday ?? 0} 条评论`)),
      el('div', { className: 'stat-tile' },
        el('div', { className: 'stat-k' }, '今日粉丝互动回复'),
        el('div', { className: 'stat-v' }, `私信 ${fq.dmTotal ?? 0} 条 · 评论 ${fq.commentTotal ?? 0} 条`)),
      el('div', { className: 'stat-tile' },
        el('div', { className: 'stat-k' }, '今日作息计划'),
        el('div', { className: 'stat-v' }, st.plan ? `${st.plan.action} · ${st.plan.atText || '-'}（已醒 ${st.plan.wakes} 次）` : '尚无今日计划')),
      el('div', { className: 'stat-tile' },
        el('div', { className: 'stat-k' }, '内容安全审核拦截'),
        el('div', { className: 'stat-v' }, `近期拦截 ${st.safetyBlockedCount ?? 0} 次`))),
    el('div', { className: 'worker-pills' },
      workerPill('记忆归纳', st.formation),
      workerPill('安全复审', st.safetyWorker),
      workerPill('心情分析', st.affectWorker),
      workerPill('社交判断', st.socialWorker)),
    st.scheduler?.lastError ? el('div', { className: 'banner err', style: { marginTop: '10px', marginBottom: 0 } }, '最近调度异常：' + st.scheduler.lastError.message) : null)

  const memoryCard = el('div', { className: 'card' },
    el('div', { className: 'card-head' },
      el('div', { className: 'inline' },
        el('h2', {}, '大鲸鱼的长期记忆'),
        life ? el('span', { className: 'pill' }, `活跃记忆 ${activeMemories.length} 条 · 近期经历 ${life.events ?? 0} 条`) : null),
      el('div', { className: 'inline' },
        el('button', { type: 'button', className: 'btn', disabled: !!state.busy, onClick: () => actions.runLife('status') }, '刷新记忆'),
        el('button', { type: 'button', className: 'btn', disabled: !!state.busy, onClick: () => actions.runLife('export') }, '导出记忆备份'))),
    el('p', { className: 'card-sub' }, '所有长期记忆均由 Antigravity 内置模型根据大鲸鱼的真实观看与互动经历自动归纳。你可以补充偏好、检索经历，或固定/删除某条记忆。'),
    row('告诉她一条明确偏好', '例如「以后多看 AI 工具评测，少推荐手游」，保存后会写入经历并纳入记忆归纳。',
      el('div', { className: 'inline' },
        el('input', {
          className: 'input wide',
          value: state.lifeNote,
          placeholder: '输入你想让她记住的偏好或说明',
          onInput: e => { state.lifeNote = e.target.value },
        }),
        el('button', {
          type: 'button',
          className: 'btn primary',
          disabled: !!state.busy || !String(state.lifeNote || '').trim(),
          onClick: () => actions.saveOwnerNote(),
        }, '保存偏好'))),
    row('搜索她的过往经历', '输入关键词检索她看过哪些视频、聊过哪些话题。',
      el('div', { className: 'inline' },
        el('input', {
          className: 'input',
          value: state.lifeQuery,
          placeholder: '输入关键词搜索',
          onInput: e => { state.lifeQuery = e.target.value },
          onKeydown: e => { if (e.key === 'Enter') { e.preventDefault(); void actions.searchExperiences() } },
        }),
        el('button', { type: 'button', className: 'btn', disabled: !!state.busy, onClick: actions.searchExperiences }, '搜索'))),
    state.lifeMsg ? el('div', { className: 'banner ok', style: { marginTop: '10px', marginBottom: 0 } }, state.lifeMsg) : null,
    state.lifeError ? el('div', { className: 'banner err', style: { marginTop: '10px', marginBottom: 0 } }, state.lifeError) : null,
    searchResults
      ? el('div', { style: { marginTop: '12px' } },
          el('div', { className: 'inline', style: { justifyContent: 'space-between', marginBottom: '6px' } },
            el('strong', {}, `检索结果（共 ${searchResults.length} 条）`),
            el('button', { type: 'button', className: 'btn sm', onClick: () => { state.lifeSearchItems = null; actions.rerender() } }, '收起结果')),
          searchResults.length === 0
            ? el('div', { className: 'row-hint' }, '未找到与该关键词相关的经历记录。')
            : el('div', {}, ...searchResults.slice(0, 15).map(item => el('div', { className: 'item-card' },
                el('div', {}, item.text || item.summary || JSON.stringify(item).slice(0, 200)),
                el('div', { className: 'row-hint mono', style: { marginTop: '4px' } },
                  `${item.kind || 'event'}${item.target ? ' · ' + item.target : ''}${item.at ? ' · ' + new Date(item.at).toLocaleString('zh-CN') : ''}`)))))
      : null,
    el('div', { className: 'model-section-title', style: { marginTop: '16px' } }, `她目前记住的事（${activeMemories.length} 条活跃记忆）`),
    activeMemories.length === 0
      ? el('div', { className: 'row-hint', style: { padding: '8px 0' } }, '目前还没有形成长期记忆；大鲸鱼开始看片或和你互动后会自动提炼到这里。')
      : el('div', {}, ...activeMemories.map(m => {
          const suppressed = m.recallEnabled === false
          const protectedMem = m.protected === true || m.retentionProtected === true
          return el('div', { className: 'item-card' },
            el('div', { className: 'inline', style: { justifyContent: 'space-between', marginBottom: '4px' } },
              el('div', { className: 'inline' },
                el('span', { className: 'pill' }, m.type || '记忆'),
                protectedMem ? el('span', { className: 'pill ok' }, '已固定保护') : null,
                suppressed ? el('span', { className: 'pill warn' }, '已暂停回忆') : null),
              el('span', { className: 'row-hint mono' }, `v${m.version ?? 1}`)),
            el('div', { style: { margin: '4px 0 8px' } }, m.text),
            el('div', { className: 'inline' },
              el('button', {
                type: 'button',
                className: 'btn sm',
                disabled: !!state.busy,
                onClick: () => actions.runLife('memory-retention', { id: m.id, protect: !protectedMem, reason: '主人在控制台调整记忆保护' }),
              }, protectedMem ? '取消保护' : '固定保护'),
              el('button', {
                type: 'button',
                className: 'btn sm',
                disabled: !!state.busy,
                onClick: () => actions.runLife('suppress', { id: m.id, value: !suppressed }),
              }, suppressed ? '恢复回忆' : '暂停回忆'),
              el('button', {
                type: 'button',
                className: 'btn danger sm',
                disabled: !!state.busy,
                onClick: () => actions.runLife('revoke', { id: m.id }),
              }, '删除记忆')))
        })),
    (life?.pending ?? []).length > 0
      ? el('div', { className: 'item-card', style: { marginTop: '14px', borderColor: 'color-mix(in srgb, var(--warn) 45%, transparent)' } },
          el('strong', {}, `⚠ 未确认发送核查（${life.pending.length} 条）`),
          el('div', { className: 'row-hint', style: { marginTop: '4px' } }, '以下发送因网络超时结果未知；请到 B 站确认是否已发出后再手动结案，避免重复发送。'),
          el('div', { className: 'inline', style: { marginTop: '8px' } },
            el('label', { className: 'switch' },
              el('input', { type: 'checkbox', checked: state.lifeVerified, onChange: e => { state.lifeVerified = e.target.checked; actions.rerender() } }),
              el('span', {}, '我已到 B 站核查')),
            el('input', { className: 'input', value: state.lifeReceipt, placeholder: '已发出请填回执 ID', onInput: e => { state.lifeReceipt = e.target.value; actions.rerender() } })),
          ...life.pending.map(p => el('div', { className: 'inline', style: { justifyContent: 'space-between', marginTop: '8px' } },
            el('span', {}, `${p.channel} → ${p.target}`),
            el('div', { className: 'inline' },
              el('button', { type: 'button', className: 'btn sm primary', disabled: !!state.busy || !state.lifeVerified || !state.lifeReceipt, onClick: () => actions.runLife('resolve', { id: p.id, status: 'sent', receipt: state.lifeReceipt, confirmed: state.lifeVerified }) }, '确认已发出'),
              el('button', { type: 'button', className: 'btn sm', disabled: !!state.busy || !state.lifeVerified, onClick: () => actions.runLife('resolve', { id: p.id, status: 'not-sent', confirmed: state.lifeVerified }) }, '确认未发出')))))
      : null)

  return el('div', {}, activityCard, memoryCard)
}
