import { el, row } from './render-sections.js'

const TOPICS = {
  animals: '动物', remix: '鬼畜', technology: '科技数码', food: '美食',
  'daily-life': '生活', film: '影视', games: '游戏', history: '历史', outdoors: '户外', general: '通用',
}
const INTENTS = {
  reaction: '反应', observation: '观察', question: '提问', 'technical-help': '技术说明', discussion: '讨论',
}

export function renderMemoryTab(state, actions) {
  const life = state.lifeState
  const cState = state.corpusStatus
  const cItems = state.corpusItems ?? []
  const cTotal = state.corpusTotal ?? 0
  const chosen = state.corpusChosen

  const lBtn = (label, action, params = {}, disabled = false) => el('button', {
    className: 'btn',
    disabled: !!state.busy || disabled,
    onClick: () => actions.runLife(action, params),
  }, label)

  const lifeCard = el('div', { className: 'card' },
    el('div', { className: 'inline', style: { justifyContent: 'space-between', marginBottom: '8px' } },
      el('h2', { style: { margin: 0 } }, '长期记忆、提案与线程管理'),
      lBtn('刷新记忆状态', 'status')),
    el('p', { className: 'card-sub' }, '所有长期记忆均来自可核对的真实经历，由 Antigravity 内置模型自动归纳与独立审核；导出包含私人记录。'),
    life ? el('div', { className: 'row-hint', style: { marginBottom: '10px' } },
      `近期事件 ${life.events} · 归档 ${life.archives} · 待审提案 ${(life.proposals ?? []).filter(p => p.status === 'pending').length} · 活跃记忆 ${(life.memories ?? []).filter(m => m.active).length} · 未确认发送 ${(life.pending ?? []).length} · 自动归纳：${life.formationWorker?.status ?? '-'}`) : null,
    el('div', { className: 'inline', style: { marginBottom: '10px' } },
      life ? lBtn(life.paused ? '恢复主动活动' : '暂停主动活动', 'pause', { value: !life.paused }) : null,
      lBtn('动态记忆状态', 'dynamic-status'),
      lBtn('学习状态', 'learning-status'),
      lBtn('行为轨迹', 'traces'),
      lBtn('维护短期状态', 'maintain'),
      lBtn('归档', 'archive'),
      lBtn('重建检索索引', 'rebuild-index'),
      lBtn('校验恢复检查点', 'replay-check'),
      lBtn('导出完整 JSON', 'export')),

    row('检索经历（含冷归档）', '',
      el('div', { className: 'inline' },
        el('input', { className: 'input', value: state.lifeQuery, placeholder: '输入关键词搜索', onInput: e => { state.lifeQuery = e.target.value } }),
        el('button', { className: 'btn', disabled: !!state.busy, onClick: () => actions.runLife('search', { query: state.lifeQuery }) }, '检索'))),

    row('保存主人反馈原文', '保存后将返回来源事件 ID，可用于手动提案。',
      el('div', { className: 'inline' },
        el('input', { className: 'input wide', value: state.lifeNote, placeholder: '你的明确反馈或偏好说明', onInput: e => { state.lifeNote = e.target.value } }),
        el('button', { className: 'btn primary', disabled: !!state.busy, onClick: () => actions.runLife('owner-note', { text: state.lifeNote }) }, '保存反馈'))),

    el('details', { className: 'fold' },
      el('summary', {}, '手动提交记忆提案（JSON）'),
      el('div', { className: 'stack', style: { marginTop: '8px' } },
        el('textarea', { className: 'textarea mono', rows: 4, value: state.lifeProposal, onInput: e => { state.lifeProposal = e.target.value } }),
        el('div', {}, el('button', { className: 'btn', disabled: !!state.busy, onClick: actions.submitProposal }, '提交提案')))),

    ...(life?.proposals ?? []).filter(p => p.status === 'pending').map(p => el('div', { className: 'item-card' },
      el('strong', {}, `${p.type} · ${p.text}`),
      el('div', { className: 'row-hint mono', style: { marginTop: '4px' } }, JSON.stringify({ id: p.id, sourceIds: p.sourceIds, visibility: p.visibility, scope: p.scope })),
      el('div', { className: 'inline', style: { marginTop: '8px' } },
        lBtn('查看来源', 'sources', { ids: p.sourceIds }),
        p.type !== 'reopen' ? lBtn('接受', 'accept', { id: p.id, expectedRevision: life.revision }) : null,
        lBtn('拒绝', 'reject', { id: p.id })))),

    el('details', { className: 'fold', open: (life?.memories ?? []).filter(m => m.active).length > 0 && (life?.memories ?? []).filter(m => m.active).length <= 8 },
      el('summary', {}, `活跃记忆（${(life?.memories ?? []).filter(m => m.active).length} 条）`),
      ...(life?.memories ?? []).filter(m => m.active).map(m => el('div', { className: 'item-card' },
        el('div', {}, m.text),
        el('div', { className: 'row-hint mono', style: { marginTop: '4px' } }, `ID ${m.id} · ${m.type} · v${m.version ?? 1} · recall=${m.recallEnabled !== false}`),
        el('div', { className: 'inline', style: { marginTop: '8px' } },
          lBtn(m.recallEnabled === false ? '恢复取回' : '停止取回', 'suppress', { id: m.id, value: m.recallEnabled !== false }),
          lBtn('动态解释', 'memory-explain', { id: m.id }),
          lBtn('保护保存', 'memory-retention', { id: m.id, protect: true, reason: '主人在控制台要求保护保存' }),
          lBtn('取消保护', 'memory-retention', { id: m.id, protect: false }),
          lBtn('撤销/回退', 'revoke', { id: m.id }))))),

    (life?.threads ?? []).length > 0 ? el('details', { className: 'fold' },
      el('summary', {}, `评论线程（最近 ${Math.min(30, life.threads.length)} 条）`),
      el('div', { className: 'inline', style: { marginTop: '8px' } },
        el('input', { className: 'input', value: state.lifeEventId, placeholder: '恢复线程需填入新收件事件 ID', onInput: e => { state.lifeEventId = e.target.value } })),
      ...(life.threads ?? []).slice(-30).map(t => el('div', { className: 'item-card inline', style: { justifyContent: 'space-between' } },
        el('span', { className: 'mono' }, `${t.key} · ${t.status} · 本段 ${t.count} / 当日 ${t.daily}`),
        el('div', { className: 'inline' },
          lBtn('结束', 'close', { thread: t.key }),
          lBtn('恢复', 'reopen', { thread: t.key, eventId: state.lifeEventId }, !state.lifeEventId))))) : null,

    (life?.pending ?? []).length > 0 ? el('details', { className: 'fold', open: true },
      el('summary', {}, `未确认发送核查（${life.pending.length} 条）`),
      el('div', { className: 'inline', style: { marginTop: '8px' } },
        el('label', { className: 'switch' },
          el('input', { type: 'checkbox', checked: state.lifeVerified, onChange: e => { state.lifeVerified = e.target.checked; actions.rerender() } }),
          el('span', {}, '我已到 B 站平台核查')),
        el('input', { className: 'input', value: state.lifeReceipt, placeholder: '已发出请填平台回执 ID', onInput: e => { state.lifeReceipt = e.target.value; actions.rerender() } })),
      ...life.pending.map(p => el('div', { className: 'item-card inline', style: { justifyContent: 'space-between' } },
        el('span', {}, `${p.channel} → ${p.target}`),
        el('div', { className: 'inline' },
          lBtn('确认已发出', 'resolve', { id: p.id, status: 'sent', receipt: state.lifeReceipt, confirmed: state.lifeVerified }, !state.lifeVerified || !state.lifeReceipt),
          lBtn('确认未发出', 'resolve', { id: p.id, status: 'not-sent', confirmed: state.lifeVerified }, !state.lifeVerified))))) : null,

    state.lifeError ? el('div', { className: 'banner err', style: { marginTop: '10px' } }, state.lifeError) : null,
    state.lifeResult ? el('pre', { className: 'console-out' }, state.lifeResult) : null)

  const corpusCard = el('div', { className: 'card' },
    el('div', { className: 'inline', style: { justifyContent: 'space-between', marginBottom: '8px' } },
      el('h2', { style: { margin: 0 } }, '表达参考库与语料审核'),
      el('div', { className: 'inline' },
        el('select', {
          className: 'select',
          value: state.corpusFilter,
          onChange: (e) => { state.corpusFilter = e.target.value; state.corpusOffset = 0; state.corpusChosen = null; actions.runCorpus('list') },
        }, Object.entries({ pending: '待审核', quarantined: '隔离观察', approved: '已批准/内置', rejected: '已拒绝' }).map(([v, t]) => el('option', { value: v, selected: state.corpusFilter === v }, t))),
        el('button', { className: 'btn', disabled: !!state.busy, onClick: () => actions.runCorpus('list') }, '刷新'),
        el('button', { className: 'btn', disabled: !!state.busy, onClick: () => actions.runCorpus('export') }, '导出'))),
    el('p', { className: 'card-sub' }, '只审核写法参考，不写入主人记忆或视频事实。批量导入可用：node tools/bili.mjs corpus import <文件或目录>。'),
    cState ? el('div', { className: 'row-hint', style: { marginBottom: '8px' } }, `可用 ${cState.approved}（内置 ${cState.seed}） · 待审 ${cState.pending} · 隔离 ${cState.quarantined} · 第 ${cTotal ? state.corpusOffset + 1 : 0}–${Math.min(cTotal, state.corpusOffset + cItems.length)} / 共 ${cTotal}`) : null,
    ...cItems.map(item => el('div', { className: 'item-card' },
      el('div', {}, item.text),
      el('div', { className: 'row-hint mono', style: { marginTop: '4px' } }, `${item.id} · ${item.topic} · ${item.intent} · ${item.bvid || ''}`),
      el('div', { className: 'inline', style: { marginTop: '8px' } },
        el('button', { className: 'btn', onClick: () => { state.corpusChosen = item; state.corpusTopic = item.topic || 'general'; state.corpusIntent = item.intent || 'reaction'; state.corpusAck = false; state.corpusNote = ''; actions.rerender() } }, '查看并标注'),
        state.corpusFilter === 'approved' ? el('button', { className: 'btn danger', disabled: !!state.busy, onClick: () => actions.runCorpus('revoke', { id: item.id }) }, '撤销') : null))),
    el('div', { className: 'inline', style: { marginTop: '10px' } },
      el('button', { className: 'btn', disabled: !!state.busy || state.corpusOffset === 0, onClick: () => { state.corpusOffset = Math.max(0, state.corpusOffset - 10); actions.runCorpus('list') } }, '上一页'),
      el('button', { className: 'btn', disabled: !!state.busy || state.corpusOffset + cItems.length >= cTotal, onClick: () => { state.corpusOffset += 10; actions.runCorpus('list') } }, '下一页')),
    chosen ? el('div', { className: 'item-card', style: { marginTop: '12px' } },
      el('pre', { className: 'console-out', style: { marginTop: 0 } }, chosen.text),
      el('div', { className: 'inline', style: { marginTop: '8px' } },
        el('select', { className: 'select', value: state.corpusTopic, onChange: e => { state.corpusTopic = e.target.value } }, Object.entries(TOPICS).map(([k, v]) => el('option', { value: k, selected: state.corpusTopic === k }, v))),
        el('select', { className: 'select', value: state.corpusIntent, onChange: e => { state.corpusIntent = e.target.value } }, Object.entries(INTENTS).map(([k, v]) => el('option', { value: k, selected: state.corpusIntent === k }, v))),
        el('input', { className: 'input', value: state.corpusNote, placeholder: '审核说明', onInput: e => { state.corpusNote = e.target.value } })),
      el('div', { className: 'inline', style: { marginTop: '8px' } },
        el('label', { className: 'switch' },
          el('input', { type: 'checkbox', checked: state.corpusAck, onChange: e => { state.corpusAck = e.target.checked } }),
          el('span', {}, '已查看候选标记')),
        el('button', { className: 'btn primary', disabled: !!state.busy || state.corpusFilter === 'approved', onClick: () => actions.runCorpus('review', { id: chosen.id, review: { action: 'approve', topic: state.corpusTopic, intent: state.corpusIntent, note: state.corpusNote, acknowledgeFlags: state.corpusAck } }) }, '批准为写法参考'),
        el('button', { className: 'btn danger', disabled: !!state.busy || state.corpusFilter === 'approved', onClick: () => actions.runCorpus('review', { id: chosen.id, review: { action: 'reject', note: state.corpusNote } }) }, '拒绝'))) : null,
    state.corpusError ? el('div', { className: 'banner err', style: { marginTop: '10px' } }, state.corpusError) : null)

  return el('div', {}, lifeCard, corpusCard)
}
