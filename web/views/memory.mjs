import { el, row, selectCtrl, renderExportResult } from './sections.mjs'

const WEEKDAYS = ['一', '二', '三', '四', '五', '六', '日']

const EMPTY_STAT = Object.freeze({
  watched: 0,
  shares: 0,
  dynamics: 0,
  autoComments: 0,
  ownerInteract: 0,
  ownerDm: 0,
  ownerComment: 0,
  fanInteract: 0,
  fanDm: 0,
  fanComment: 0,
  fanMention: 0,
  wakes: 0,
  safetyBlocked: 0,
  total: 0,
  items: [],
})

function pad2(n) { return String(n).padStart(2, '0') }

function localTodayStr() {
  const d = new Date()
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`
}

function buildMonthGrid(monthStr) {
  const [yRaw, mRaw] = String(monthStr || '').split('-').map(n => Number.parseInt(n, 10))
  const now = new Date()
  const year = Number.isFinite(yRaw) ? yRaw : now.getFullYear()
  const month = Number.isFinite(mRaw) ? mRaw : (now.getMonth() + 1)
  const firstDay = new Date(year, month - 1, 1)
  const leading = (firstDay.getDay() + 6) % 7 // 周一为 0，周日为 6
  const daysInMonth = new Date(year, month, 0).getDate()
  const totalCells = Math.ceil((leading + daysInMonth) / 7) * 7
  const cells = []
  for (let i = 0; i < totalCells; i++) {
    const d = new Date(year, month - 1, 1 - leading + i)
    const dayStr = `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`
    cells.push({
      dayStr,
      dayNum: d.getDate(),
      inMonth: d.getFullYear() === year && (d.getMonth() + 1) === month,
    })
  }
  return { year, month, cells }
}

function metricTile(label, value, sub = '') {
  return el('div', { className: 'metric-tile' },
    el('div', { className: 'metric-k' }, label),
    el('div', { className: 'metric-v' }, value),
    sub ? el('div', { className: 'metric-sub' }, sub) : null)
}

function ownerSubText(s) {
  return `私信 ${s.ownerDm ?? 0} · 评论 ${s.ownerComment ?? 0}`
}

function fanSubText(s) {
  const base = `私信 ${s.fanDm ?? 0} · 评论 ${s.fanComment ?? 0}`
  return (s.fanMention ?? 0) > 0 ? `${base} · @总结 ${s.fanMention}` : base
}

const PLAN_ACTION_LABELS = {
  done: '今日已完成',
  wake: '待唤醒',
  skip: '本次按概率跳过',
}

function formatPlanStatus(plan) {
  if (!plan) return '尚无今日计划'
  const wakes = Number(plan.wakes ?? 0)
  const label = PLAN_ACTION_LABELS[plan.action] || '待排期'
  const timePart = plan.action === 'done' || !plan.atText ? '' : ` · ${plan.atText}`
  return `${label}${timePart}（已用 ${wakes} 次机会）`
}

const EVENT_KIND_LABELS = {
  'video-read': '观看视频',
  sent: '已发送',
  received: '收到消息',
  reflection: '自我反思',
  observed: '观察记录',
  'activity-result': '活动结果',
  'activity-started': '开始活动',
  'memory-accepted': '记忆入库',
  'memory-revoked': '撤销记忆',
  'visibility-checked': '评论回读',
  'thread-closed': '会话结束',
  'thread-reopened': '恢复会话',
  'send-rejected': '发送未通过',
  'wake-delivery-accepted': '作息唤醒',
  'wake-delivery-failed': '唤醒失败',
  'wake-delivery-unconfirmed': '唤醒未确认',
  'wake-delivery-forced-release': '唤醒超时释放',
  'session-delivery-accepted': '会话投递',
  'session-delivery-failed': '投递失败',
  'session-delivery-unconfirmed': '投递未确认',
  'night-triggered': '手动唤醒',
  'night-trigger-rejected': '手动唤醒未执行',
}

const CHANNEL_LABELS = {
  comment: '评论',
  dm: '私信',
  dynamic: '动态',
}

function eventKindLabel(kind) {
  return EVENT_KIND_LABELS[kind] || '活动记录'
}

function channelLabel(ch) {
  return CHANNEL_LABELS[ch] || '外发消息'
}

/**
 * Tab 6：动态与记忆
 * - 上半区：累计总计 + 今日/任意日期互动统计日历（看片/分享/动态/主人互动/粉丝互动/唤醒/安全拦截）。
 * - 下半区：极简长期记忆管理（仅显示活跃记忆数统计、过往经历搜索支持 20/50/100 条、时间戳导出备份）。
 */
export function renderMemoryTab(state, actions) {
  const sentButtons = []
  function confirmSentButton(item) {
    const button = el('button', {
      type: 'button', className: 'btn sm primary',
      disabled: !!state.busy || !state.lifeVerified || !state.lifeReceipt.trim(),
      onClick: () => actions.runLife('resolve', {
        id: item.id, status: 'sent', receipt: state.lifeReceipt.trim(), confirmed: state.lifeVerified,
      }),
    }, '确认已发出')
    sentButtons.push(button)
    return button
  }
  const st = state.status ?? {}
  const life = state.lifeState
  const activeMemoriesCount = (life?.memories ?? []).filter(m => m.active).length
  const searchResults = Array.isArray(state.lifeSearchItems) ? state.lifeSearchItems : null

  const cal = st.calendar ?? {}
  const today = cal.today || st.today || localTodayStr()
  const selectedDay = state.calSelectedDate || today
  const activeMonth = state.calMonth || selectedDay.slice(0, 7)
  const isToday = selectedDay === today
  const totals = { ...EMPTY_STAT, ...(cal.totals ?? {}) }
  const daysMap = cal.days ?? {}
  const dayStat = { ...EMPTY_STAT, ...(daysMap[selectedDay] ?? {}) }
  const { year, month, cells } = buildMonthGrid(activeMonth)

  const summaryBlock = el('div', { className: 'cal-summary-box' },
    cal.incomplete ? el('p', { role:'status' }, '部分长期记录读取或校验失败，日历仅统计已核实的记录。') : null,
    el('div', { className: 'cal-section-head' },
      el('div', { className: 'inline' },
        el('strong', {}, '累计总计'),
        el('span', { className: 'pill' }, `活跃 ${cal.activeDays ?? 0} 天`),
        el('span', { className: 'pill info' }, `共 ${totals.total ?? 0} 项活动`))),
    el('div', { className: 'metric-grid' },
      metricTile('累计看片', `${totals.watched} 条`),
      metricTile('累计分享', `${totals.shares} 条`),
      metricTile('累计动态', `${totals.dynamics} 条`),
      metricTile('自主评论', `${totals.autoComments} 条`),
      metricTile('主人互动', `${totals.ownerInteract} 次`, ownerSubText(totals)),
      metricTile('粉丝互动', `${totals.fanInteract} 次`, fanSubText(totals)),
      metricTile('作息唤醒', `${totals.wakes} 次`, totals.opportunitiesUsed > 0 ? `近期窗口已用 ${totals.opportunitiesUsed} 次机会` : ''),
      metricTile('安全拦截', `${totals.safetyBlocked} 次`)))

  const calendarPanel = el('div', { className: 'cal-panel' },
    el('div', { className: 'cal-nav' },
      el('button', { type: 'button', className: 'btn sm cal-nav-btn', onClick: () => actions.shiftCalMonth(-1) }, '上月'),
      el('span', { className: 'cal-month-title' }, `${year}年${month}月`),
      el('div', { className: 'cal-nav-group' },
        el('button', { type: 'button', className: 'btn sm cal-nav-btn', onClick: actions.jumpCalToday }, '今天'),
        el('button', { type: 'button', className: 'btn sm cal-nav-btn', onClick: () => actions.shiftCalMonth(1) }, '下月'))),
    el('div', { className: 'cal-weekdays' }, ...WEEKDAYS.map(w => el('span', {}, w))),
    el('div', { className: 'cal-grid' }, ...cells.map(c => {
      const info = daysMap[c.dayStr]
      const count = Number(info?.total ?? 0)
      const lvl = count >= 7 ? 'lvl-3' : count >= 3 ? 'lvl-2' : count >= 1 ? 'lvl-1' : ''
      const cls = [
        'cal-cell',
        c.inMonth ? '' : 'outside',
        c.dayStr === today ? 'today' : '',
        c.dayStr === selectedDay ? 'selected' : '',
        lvl,
      ].filter(Boolean).join(' ')
      return el('button', {
        type: 'button',
        className: cls,
        onClick: () => actions.selectCalDay(c.dayStr),
      },
      el('span', { className: 'cal-day-num' }, String(c.dayNum)),
      count > 0 ? el('span', { className: 'cal-day-badge' }, count > 99 ? '99+' : String(count)) : null)
    })),
    el('div', { className: 'cal-legend' },
      el('span', { className: 'row-hint' }, '活跃度：'),
      el('span', { className: 'cal-legend-item' }, el('span', { className: 'cal-dot lvl-1' }), '1–2'),
      el('span', { className: 'cal-legend-item' }, el('span', { className: 'cal-dot lvl-2' }), '3–6'),
      el('span', { className: 'cal-legend-item' }, el('span', { className: 'cal-dot lvl-3' }), '7+')))

  const dayEvents = Array.isArray(dayStat.items) ? dayStat.items.slice(0, 5) : []
  const detailPanel = el('div', { className: 'cal-detail' },
    el('div', { className: 'cal-section-head' },
      el('div', { className: 'inline' },
        el('strong', {}, isToday ? `今日统计（${selectedDay}）` : `${selectedDay} 统计`),
        el('span', { className: 'pill ' + (isToday ? 'ok' : '') }, isToday ? '今天' : '历史日期'),
        el('span', { className: 'pill' }, `共 ${dayStat.total ?? 0} 项`)),
      !isToday
        ? el('button', { type: 'button', className: 'btn sm', onClick: actions.jumpCalToday }, '回到今天')
        : null),
    isToday
      ? el('div', { className: 'cal-plan-line' },
          el('span', { className: 'row-hint' }, '今日作息计划：'),
          el('span', {}, formatPlanStatus(st.plan)))
      : null,
    el('div', { className: 'day-stat-grid' },
      metricTile('观看视频', `${dayStat.watched} 条`),
      metricTile('主动分享给主人', isToday ? `${dayStat.shares} / ${st.sharesMax ?? 3} 条` : `${dayStat.shares} 条`),
      metricTile('发布公开动态', isToday ? `${dayStat.dynamics} / ${st.dynamicDailyMax ?? 1} 条` : `${dayStat.dynamics} 条`),
      metricTile('自主评论', isToday ? `${dayStat.autoComments} / ${st.autoCommentDailyMax ?? 3} 条` : `${dayStat.autoComments} 条`),
      metricTile('主人互动', `${dayStat.ownerInteract} 次`, ownerSubText(dayStat)),
      metricTile('粉丝互动', `${dayStat.fanInteract} 次`, fanSubText(dayStat)),
      metricTile('作息唤醒', `${dayStat.wakes} 次`, dayStat.opportunitiesUsed > 0 ? `当日窗口已用 ${dayStat.opportunitiesUsed} 次机会` : ''),
      metricTile('安全审核拦截', `${dayStat.safetyBlocked} 次`)),
    el('div', { className: 'day-events-wrap' },
      el('div', { className: 'row-hint', style: { fontWeight: 600, marginBottom: '6px' } },
        dayEvents.length > 0 ? `当日活动明细（最近 ${dayEvents.length} 条）` : '当日活动明细'),
      dayEvents.length === 0
        ? el('div', { className: 'row-hint' }, '该日期暂无记录到的活动。')
        : el('div', { className: 'day-events' }, ...dayEvents.map(ev => el('div', { className: 'day-event-item' },
            el('span', { className: 'day-event-time mono' }, ev.time || '--:--'),
            el('span', { className: `pill ${ev.kind === 'safety' ? 'warn' : ev.kind === 'owner' ? 'info' : ''}` }, ev.label),
            el('span', { className: 'day-event-text' }, ev.text || '-'))))))

  const activityCard = el('div', { className: 'card' },
    el('div', { className: 'card-head' },
      el('div', { className: 'inline' },
        el('h2', {}, '活动统计与日历查看'),
        life
          ? el('span', { className: 'pill ' + (life.paused ? 'warn' : 'ok') }, el('span', { className: 'dot' }), life.paused ? '主动活动已暂停' : '正常运行中')
          : null,
        st.modelQuota?.paused
          ? el('span', { className: 'pill warn' }, el('span', { className: 'dot' }), `配额保护已暂停（剩余 ${st.modelQuota.remainingPercent}% < ${st.modelQuota.threshold}%）`)
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
    summaryBlock,
    el('div', { className: 'cal-layout' }, calendarPanel, detailPanel),
    st.scheduler?.lastError ? el('div', { className: 'banner err', style: { marginTop: '10px', marginBottom: 0 } }, '最近调度异常：' + st.scheduler.lastError.message) : null)

  const memoryCard = el('div', { className: 'card' },
    el('div', { className: 'card-head' },
      el('div', { className: 'inline' },
        el('h2', {}, '大鲸鱼的长期记忆'),
        life ? el('span', { className: 'pill' }, `活跃记忆 ${activeMemoriesCount} 条 · 近期经历 ${life.events ?? 0} 条`) : null),
      el('div', { className: 'inline' },
        el('button', { type: 'button', className: 'btn', disabled: !!state.busy, onClick: () => actions.runLife('status') }, '刷新记忆'),
        el('button', { type: 'button', className: 'btn', disabled: !!state.busy, onClick: () => actions.runLife('export') }, state.busy === 'life' ? '导出中…' : '导出记忆备份'))),
    el('p', { className: 'card-sub' }, '所有长期记忆均由 Antigravity 内置模型自动归纳维护并在后台生效；页面不平铺展示记忆条目，可通过下方搜索过往经历或导出带时间戳的备份文件查看。'),
    row('搜索她的过往经历', '输入关键词检索她看过哪些视频、聊过哪些话题（默认最多显示 20 条，可按需切换至 50 / 100 条）。',
      el('div', { className: 'inline' },
        el('input', {
          className: 'input',
          value: state.lifeQuery,
          placeholder: '输入关键词搜索',
          onInput: e => { state.lifeQuery = e.target.value },
          onKeydown: e => { if (e.key === 'Enter') { e.preventDefault(); void actions.searchExperiences() } },
        }),
        selectCtrl(String(state.lifeLimit || 20), [
          ['20', '最多 20 条（默认）'],
          ['50', '最多 50 条'],
          ['100', '最多 100 条'],
        ], v => {
          state.lifeLimit = Number(v) || 20
          if (state.lifeSearchItems !== null) void actions.searchExperiences()
          else actions.rerender()
        }),
        el('button', { type: 'button', className: 'btn', disabled: !!state.busy, onClick: actions.searchExperiences }, '搜索'))),
    renderExportResult(state.memoryExport, actions),
    state.lifeError ? el('div', { className: 'banner err', style: { marginTop: '10px', marginBottom: 0 } }, state.lifeError) : null,
    searchResults
      ? el('div', { style: { marginTop: '12px' } },
          el('div', { className: 'inline', style: { justifyContent: 'space-between', marginBottom: '6px' } },
            el('strong', {}, `检索结果（共 ${searchResults.length} 条 · 当前上限 ${state.lifeSearchLimitUsed || state.lifeLimit || 20} 条）`),
            el('button', { type: 'button', className: 'btn sm', onClick: () => { state.lifeSearchItems = null; actions.rerender() } }, '收起结果')),
          searchResults.length === 0
            ? el('div', { className: 'row-hint' }, '未找到与该关键词相关的经历记录。')
            : el('div', {}, ...searchResults.map(item => el('div', { className: 'item-card' },
                el('div', {}, item.text || item.summary || JSON.stringify(item).slice(0, 200)),
                el('div', { className: 'row-hint mono', style: { marginTop: '4px' } },
                  `${eventKindLabel(item.kind)}${item.target ? ' · ' + item.target : ''}${item.at ? ' · ' + new Date(item.at).toLocaleString('zh-CN') : ''}`)))))
      : null,
    (life?.pending ?? []).length > 0
      ? el('div', { className: 'item-card', style: { marginTop: '14px', borderColor: 'color-mix(in srgb, var(--warn) 45%, transparent)' } },
          el('strong', {}, `未确认发送核查（${life.pending.length} 条）`),
          el('div', { className: 'row-hint', style: { marginTop: '4px' } }, '以下发送因网络超时结果未知；请到 B 站确认是否已发出后再手动结案，避免重复发送。'),
          el('div', { className: 'inline', style: { marginTop: '8px' } },
            el('label', { className: 'switch' },
              el('input', { type: 'checkbox', checked: state.lifeVerified, onChange: e => { state.lifeVerified = e.target.checked; actions.rerender() } }),
              el('span', {}, '我已到 B 站核查')),
            el('input', { className: 'input', value: state.lifeReceipt, placeholder: '已发出请填回执 ID', onInput: e => {
              state.lifeReceipt = e.target.value
              for (const button of sentButtons) button.disabled = !!state.busy || !state.lifeVerified || !state.lifeReceipt.trim()
            } })),
          ...life.pending.map(p => el('div', { className: 'inline', style: { justifyContent: 'space-between', marginTop: '8px' } },
            el('span', {}, `${channelLabel(p.channel)} → ${p.target}`),
            el('div', { className: 'inline' },
              confirmSentButton(p),
              el('button', { type: 'button', className: 'btn sm', disabled: !!state.busy || !state.lifeVerified, onClick: () => actions.runLife('resolve', { id: p.id, status: 'not-sent', confirmed: state.lifeVerified }) }, '确认未发出')))))
      : null)

  return el('div', {}, activityCard, memoryCard)
}
