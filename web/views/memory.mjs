/**
 * Tab 6 视图（动态与记忆）：渲染运行状态控制、活动日历统计、长期记忆检索导出及未确认发送核查。
 */
import { el, row, selectCtrl, renderExportResult, statusPill, metaPill, banner } from './sections.mjs'
import { deriveActivityStatus } from '../../src/shared/activity-status.mjs'

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

function renderActivityMetrics(stats, windowLabel, limits = {}) {
  const metric = (label, key, unit, detail = '') => {
    const limit = limits[key]
    return el('div', { className: 'activity-metric' },
      el('dt', { className: 'activity-metric-label' }, label),
      el('dd', { className: 'activity-metric-count' }, `${stats[key]} ${unit}`,
        limit == null ? null : el('span', { className: 'activity-metric-limit' }, `（上限 ${limit} ${unit}）`)),
      detail ? el('dd', { className: 'activity-metric-detail' }, detail) : null)
  }
  const owner = `私信 ${stats.ownerDm ?? 0}，评论 ${stats.ownerComment ?? 0}`
  const fan = `私信 ${stats.fanDm ?? 0}，评论 ${stats.fanComment ?? 0}`
  const fanMention = stats.fanMention > 0 ? `，@ 总结 ${stats.fanMention}` : ''
  const wake = stats.opportunitiesUsed > 0
    ? `${windowLabel}窗口已用 ${stats.opportunitiesUsed} 次机会`
    : ''
  return el('dl', { className: 'activity-metrics' },
    metric('观看视频', 'watched', '条'),
    metric('主动分享', 'shares', '条'),
    metric('公开动态', 'dynamics', '条'),
    metric('自主评论', 'autoComments', '条'),
    metric('主人互动', 'ownerInteract', '次', owner),
    metric('粉丝互动', 'fanInteract', '次', fan + fanMention),
    metric('作息唤醒', 'wakes', '次', wake),
    metric('安全拦截', 'safetyBlocked', '次'))
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
  const timePart = plan.action === 'done' || !plan.atText ? '' : `，${plan.atText}`
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
 * - 上半区：累计总计 + 今日/任意日期互动统计日历（观看视频/主动分享/公开动态/自主评论/主人互动/粉丝互动/作息唤醒/安全拦截）。
 * - 下半区：极简长期记忆管理（仅显示活跃记忆数统计、过往经历检索支持 20/50/100 条、时间戳导出备份）。
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

  const summaryBlock = el('section', { className: 'cal-summary' },
    cal.incomplete ? el('p', { className: 'row-hint', role: 'status' }, '部分长期记录读取或校验失败，日历仅统计已核实的记录。') : null,
    el('div', { className: 'cal-section-head' },
      el('h3', { className: 'cal-section-title' }, '累计总计'),
      el('span', { className: 'cal-total' }, `活跃 ${cal.activeDays ?? 0} 天，共 ${totals.total ?? 0} 项活动`)),
    renderActivityMetrics(totals, '近期'))

  const calendarPanel = el('div', { className: 'cal-panel' },
    el('div', { className: 'cal-nav' },
      el('button', { type: 'button', className: 'btn sm cal-nav-btn', onClick: () => actions.shiftCalMonth(-1) }, '上月'),
      el('span', { className: 'cal-month-title' }, `${year} 年 ${month} 月`),
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
        'aria-label': `${c.dayStr}，${count} 项活动`,
        'aria-current': c.dayStr === today ? 'date' : null,
        'aria-pressed': String(c.dayStr === selectedDay),
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
  const todayLimits = isToday
    ? { shares: st.sharesMax ?? 3, dynamics: st.dynamicDailyMax ?? 1, autoComments: st.autoCommentDailyMax ?? 3 }
    : undefined
  const detailPanel = el('section', { className: 'cal-detail' },
    el('div', { className: 'cal-section-head' },
      el('h3', { className: 'cal-section-title' }, isToday ? `今日统计（${selectedDay}）` : `${selectedDay} 统计`),
      el('span', { className: 'cal-total' }, `共 ${dayStat.total ?? 0} 项`),
      !isToday
        ? el('button', { type: 'button', className: 'btn sm', onClick: actions.jumpCalToday }, '回到今天')
        : null),
    isToday
      ? el('div', { className: 'cal-plan-line' },
          el('span', { className: 'row-hint' }, '今日作息计划：'),
          el('span', {}, formatPlanStatus(st.plan)))
      : null,
    renderActivityMetrics(dayStat, '当日', todayLimits),
    el('div', { className: 'day-events-wrap' },
      el('h4', { className: 'cal-section-title' },
        dayEvents.length > 0 ? `当日活动明细（最近 ${dayEvents.length} 条）` : '当日活动明细'),
      dayEvents.length === 0
        ? el('div', { className: 'row-hint' }, '该日期暂无记录到的活动。')
        : el('ul', { className: 'day-events' }, ...dayEvents.map(ev => el('li', { className: 'day-event-item' },
            el('span', { className: 'day-event-time mono' }, ev.time || '--:--'),
            metaPill(ev.label, ev.kind === 'safety' ? 'warn' : ev.kind === 'owner' ? 'info' : ''),
            el('span', { className: 'day-event-text' }, ev.text || '-'))))))

  const activity = deriveActivityStatus({
    savedConfig: state.savedCfg ?? state.cfg,
    draftConfig: state.cfg,
    status: st,
    life,
  })
  const renderActivityAction = (act) => {
    if (!act) return null
    const cls = ['btn', act.style || ''].filter(Boolean).join(' ')
    if (act.type === 'goto_tab') {
      return el('button', {
        type: 'button',
        className: cls,
        disabled: !!state.busy,
        onClick: () => actions.switchTab(act.tab),
      }, act.label)
    }
    if (act.type === 'pause') {
      return el('button', {
        type: 'button',
        className: cls,
        disabled: !!state.busy,
        onClick: () => actions.toggleActivityPause(act.value),
      }, act.label)
    }
    return null
  }

  const activityCard = el('div', { className: 'card' },
    el('div', { className: 'card-head' },
      el('div', { className: 'inline' },
        el('h2', {}, '活动统计与日历查看'),
        activity.identity.ready ? statusPill(activity.badge.kind, activity.badge.text) : null),
      el('div', { className: 'inline' },
        renderActivityAction(activity.primaryAction),
        renderActivityAction(activity.secondaryAction),
        el('button', { type: 'button', className: 'btn', disabled: !!state.busy, onClick: actions.refreshMemoryOverview }, '刷新概览'))),
    activity.notice ? banner(activity.notice.kind, activity.notice.text, { variant: 'tight' }) : null,
    state.activityError ? banner('err', state.activityError, { variant: 'tight' }) : null,
    summaryBlock,
    el('div', { className: 'cal-layout' }, calendarPanel, detailPanel),
    st.scheduler?.lastError ? banner('err', '最近调度异常：' + st.scheduler.lastError.message, { variant: 'compact' }) : null)

  const memoryBadge = activity.identity.ready && life
    ? metaPill(`活跃记忆 ${activeMemoriesCount} 条，近期经历 ${life.events ?? 0} 条`)
    : null

  const memoryCard = el('div', { className: 'card' },
    el('div', { className: 'card-head' },
      el('div', { className: 'inline' },
        el('h2', {}, '长期记忆'),
        memoryBadge),
      el('div', { className: 'inline' },
        el('button', { type: 'button', className: 'btn', disabled: !!state.busy, onClick: () => actions.runLife('status') }, '刷新记忆'),
        el('button', { type: 'button', className: 'btn', disabled: !!state.busy, onClick: () => actions.runLife('export') }, state.busy === 'life' ? '导出中…' : '导出记忆备份'))),
    el('p', { className: 'card-sub' }, '所有长期记忆均由 Antigravity 内置模型自动归纳维护并在后台生效；页面不平铺展示记忆条目，可通过下方检索过往经历或导出带时间戳的备份文件查看。'),
    row('检索过往经历', '输入关键词检索大鲸鱼观看过的视频与聊过的话题；默认最多显示 20 条，可按需切换至 50 或 100 条。',
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
    state.lifeError ? banner('err', state.lifeError, { variant: 'compact' }) : null,
    searchResults
      ? el('div', { className: 'section-mt' },
          el('div', { className: 'inline-between mb-6' },
            el('strong', {}, `检索结果（共 ${searchResults.length} 条，当前上限 ${state.lifeSearchLimitUsed || state.lifeLimit || 20} 条）`),
            el('button', { type: 'button', className: 'btn sm', onClick: () => { state.lifeSearchItems = null; actions.rerender() } }, '收起结果')),
          searchResults.length === 0
            ? el('div', { className: 'row-hint' }, '未找到与该关键词相关的经历记录。')
            : el('div', {}, ...searchResults.map(item => el('div', { className: 'item-card' },
                el('div', {}, item.text || item.summary || JSON.stringify(item).slice(0, 200)),
                el('div', { className: 'row-hint mono hint-mt' },
                  `${eventKindLabel(item.kind)}${item.target ? '，' + item.target : ''}${item.at ? '，' + new Date(item.at).toLocaleString('zh-CN') : ''}`)))))
      : null,
    (life?.pending ?? []).length > 0
      ? el('div', { className: 'item-card warn' },
          el('strong', {}, `未确认发送核查（${life.pending.length} 条）`),
          el('div', { className: 'row-hint hint-mt' }, '以下发送因网络超时结果未知，请前往 B 站确认是否已发出后再手动结案，避免重复发送。'),
          el('div', { className: 'inline mt-8' },
            el('label', { className: 'switch' },
              el('input', { type: 'checkbox', checked: state.lifeVerified, onChange: e => { state.lifeVerified = e.target.checked; actions.rerender() } }),
              el('span', {}, '我已到 B 站核查')),
            el('input', { className: 'input', value: state.lifeReceipt, placeholder: '已发出请填回执 ID', onInput: e => {
              state.lifeReceipt = e.target.value
              for (const button of sentButtons) button.disabled = !!state.busy || !state.lifeVerified || !state.lifeReceipt.trim()
            } })),
          ...life.pending.map(p => el('div', { className: 'inline-between mt-8' },
            el('span', {}, `${channelLabel(p.channel)} → ${p.target}`),
            el('div', { className: 'inline' },
              confirmSentButton(p),
              el('button', { type: 'button', className: 'btn sm', disabled: !!state.busy || !state.lifeVerified, onClick: () => actions.runLife('resolve', { id: p.id, status: 'not-sent', confirmed: state.lifeVerified }) }, '确认未发出')))))
      : null)

  return el('div', {}, activityCard, memoryCard)
}
