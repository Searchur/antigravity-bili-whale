export function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag)
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === undefined || v === null || v === false) continue
    if (k === 'className') node.className = v
    else if (k === 'style' && typeof v === 'object') Object.assign(node.style, v)
    else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2).toLowerCase(), v)
    else if (k === 'checked') node.checked = Boolean(v)
    else if (k === 'value') node.value = String(v)
    else if (k === 'disabled') node.disabled = Boolean(v)
    else if (k === 'readOnly') node.readOnly = Boolean(v)
    else if (k === 'open') node.open = Boolean(v)
    else node.setAttribute(k, v === true ? '' : String(v))
  }
  for (const child of children.flat(Infinity)) {
    if (child === undefined || child === null || child === false) continue
    node.appendChild(typeof child === 'string' || typeof child === 'number' ? document.createTextNode(String(child)) : child)
  }
  return node
}

export const getPath = (obj, p) => p.reduce((o, k) => (o == null ? undefined : o[k]), obj)
export const setPath = (obj, p, value) => {
  let cur = obj
  for (let i = 0; i < p.length - 1; i++) {
    const k = p[i]
    if (cur[k] == null || typeof cur[k] !== 'object') cur[k] = typeof p[i + 1] === 'number' ? [] : {}
    cur = cur[k]
  }
  cur[p[p.length - 1]] = value
}

export function row(label, hint, control) {
  return el('div', { className: 'row' },
    el('div', { className: 'row-info' },
      el('div', { className: 'row-label' }, label),
      hint ? el('div', { className: 'row-hint' }, hint) : null),
    control)
}

export function switchCtrl(label, checked, onChange, disabled = false) {
  return el('label', { className: 'switch' },
    el('input', {
      type: 'checkbox',
      'aria-label': label,
      checked,
      disabled,
      onChange: (e) => onChange(e.target.checked),
    }),
    el('span', { className: 'row-hint' }, checked ? '已开启' : '已关闭'))
}

export function textCtrl(value, onChange, { wide = false, readOnly = false, placeholder = '', type = 'text' } = {}) {
  return el('input', {
    className: 'input' + (wide ? ' wide' : ''),
    type,
    value: value ?? '',
    readOnly,
    placeholder,
    onInput: (e) => onChange(type === 'number' ? (e.target.value === '' ? undefined : Number(e.target.value)) : e.target.value),
  })
}

export function listCtrl(rawArray, onChange) {
  return el('input', {
    className: 'input wide',
    value: Array.isArray(rawArray) ? rawArray.join('，') : '',
    placeholder: '用中英文逗号分隔',
    onInput: (e) => {
      const list = e.target.value.split(/[,，]/).map(s => s.trim()).filter(Boolean)
      onChange(list)
    },
  })
}

export function selectCtrl(value, options, onChange) {
  return el('select', {
    className: 'select',
    value: value ?? '',
    onChange: (e) => onChange(e.target.value),
  }, options.map(([val, text]) => el('option', { value: val, selected: String(value ?? '') === String(val) }, text)))
}

/**
 * Tab 1：大鲸鱼与主人
 * - 清晰拆分为「大鲸鱼（B 站账号与扫码登录）」与「主人（UID 与昵称）」两张卡片。
 * - 已完全移除手打导入 Cookie 方案，统一使用 B 站官方二维码扫码登录。
 */
export function renderAccountTab(state, actions) {
  const cfg = state.cfg
  const qr = state.qr
  const qrActive = ['starting', 'waiting', 'scanned'].includes(qr?.status)
  const loggedIn = Boolean(cfg.self?.mid)
  const qrLabel = {
    starting: '正在生成二维码…',
    waiting: '请打开手机哔哩哔哩 App 扫码登录。',
    scanned: '已扫码，请在手机上点击确认。',
    expired: '二维码已过期，请重新生成。',
    cancelled: '已取消，原登录态未改变。',
    success: qr?.account ? `✓ 已登录：${qr.account.name}（UID ${qr.account.mid}）` : '✓ 登录成功',
  }[qr?.status]

  const whaleCard = el('div', { className: 'card' },
    el('div', { className: 'card-head' },
      el('h2', {}, '大鲸鱼（B 站账号）'),
      loggedIn
        ? el('span', { className: 'pill ok' }, el('span', { className: 'dot' }), '已连接 B 站账号')
        : el('span', { className: 'pill warn' }, el('span', { className: 'dot' }), '尚未登录')),
    el('p', { className: 'card-sub' }, '建议为大鲸鱼准备独立的 B 站小号。凭据仅保存在 Windows 独立目录 %USERPROFILE%\\.antigravity-bili-whale\\credentials.json（受当前用户 ACL 保护，永不回显）。'),
    el('div', { className: 'account-hero' },
      el('div', { className: 'account-meta' },
        el('div', { className: 'account-name-row' },
          el('span', { className: 'account-name' }, loggedIn ? (cfg.self.name || '已登录大鲸鱼账号') : '尚未连接大鲸鱼 B 站账号'),
          loggedIn ? el('span', { className: 'pill mono' }, `UID ${cfg.self.mid}`) : null),
        el('div', { className: 'row-hint' }, loggedIn
          ? '扫码登录会自动刷新凭据；若中途取消或失败，不会覆盖现有登录态。'
          : '点击右侧「扫码登录」，使用手机哔哩哔哩 App 扫描二维码即可自动校验并写入账号信息。'),
        qrLabel ? el('div', { className: qr?.status === 'success' ? 'banner ok' : 'row-hint', style: { marginTop: '4px', marginBottom: 0 } }, qrLabel) : null,
        state.qrError || qr?.error ? el('div', { className: 'banner err', style: { marginTop: '4px', marginBottom: 0 } }, state.qrError || qr.error) : null),
      el('div', { className: 'qr-wrap' },
        qr?.image ? el('img', { className: 'qr-img', src: qr.image, alt: 'B站登录二维码' }) : null,
        el('div', { className: 'inline' },
          el('button', { type: 'button', className: 'btn primary', disabled: !!state.busy || qrActive, onClick: actions.qrStart },
            qr ? '重新生成二维码' : (loggedIn ? '重新扫码 / 换号' : '扫码登录')),
          qrActive ? el('button', { type: 'button', className: 'btn', onClick: actions.qrCancel }, '取消登录') : null))),
    row('大鲸鱼 UID（只读）', '扫码登录或依赖体检后自动写入。', textCtrl(getPath(cfg, ['self', 'mid']), () => {}, { readOnly: true, placeholder: '扫码后自动获取' })),
    row('大鲸鱼 B 站昵称（只读）', '来自 B 站账号信息接口。', textCtrl(getPath(cfg, ['self', 'name']), () => {}, { readOnly: true, placeholder: '扫码后自动获取' })))

  const ownerCard = el('div', { className: 'card' },
    el('h2', {}, '主人信息'),
    el('p', { className: 'card-sub' }, '填写你自己的 B 站 UID 和昵称，大鲸鱼据此识别「谁是主人」、定向私信与 @ 分享。'),
    row('主人 UID（mid）', '用来识别「谁是你」、谁回复了她、谁给她点了赞。', textCtrl(getPath(cfg, ['owner', 'mid']), v => actions.setCfg(['owner', 'mid'], v), { placeholder: '例如 12345678' })),
    row('主人 B 站昵称', '@ 分享或写日记提到你时使用。', textCtrl(getPath(cfg, ['owner', 'name']), v => actions.setCfg(['owner', 'name'], v), { placeholder: '你的 B 站昵称' })))

  return el('div', {}, whaleCard, ownerCard)
}

/**
 * Tab 2：人设与作息
 * - 汇总大鲸鱼的称呼、人设正文、口味偏好与作息生物钟。
 */
export function renderPersonaTab(state, actions) {
  const cfg = state.cfg

  const namingCard = el('div', { className: 'card' },
    el('h2', {}, '基础称呼'),
    el('p', { className: 'card-sub' }, '决定大鲸鱼的名字、怎么称呼你以及她怎么自称。'),
    row('角色名', '她怎么被称呼。', textCtrl(getPath(cfg, ['persona', 'name']), v => actions.setCfg(['persona', 'name'], v), { placeholder: '例如 大鲸鱼 / 小鲸鱼' })),
    row('她怎么称呼你', '例如「主人」或你的专属称呼。', textCtrl(getPath(cfg, ['persona', 'ownerTitle']), v => actions.setCfg(['persona', 'ownerTitle'], v))),
    row('她怎么自称', '例如「我」/「人家」。', textCtrl(getPath(cfg, ['persona', 'selfClaim']), v => actions.setCfg(['persona', 'selfClaim'], v))))

  const personaCard = el('div', { className: 'card' },
    el('h2', {}, '她的人设正文（仅对大鲸鱼生效，不影响日常编程对话）'),
    el('p', { className: 'card-sub' }, `保存位置：${state.personaPath || '%USERPROFILE%\\.antigravity-bili-whale\\persona.md'}。建议写身份来历、说话腔调、在意的事与边界；上限 20000 字。`),
    el('textarea', {
      className: 'textarea',
      rows: 9,
      placeholder: '例如：\n她的名字是…\n她说话习惯短句、自然…\n她喜欢…\n她绝对不会…',
      value: state.personaText,
      onInput: (e) => {
        state.personaText = e.target.value
        const counter = document.getElementById('persona-counter')
        if (counter) counter.textContent = `当前 ${state.personaText.length} 字 / 上限 20000 字`
      },
    }),
    el('div', { className: 'inline', style: { marginTop: '10px', justifyContent: 'space-between' } },
      el('span', { id: 'persona-counter', className: 'row-hint' }, `当前 ${state.personaText.length} 字 / 上限 20000 字（磁盘 ${state.personaBytes} 字节）`),
      el('button', { type: 'button', className: 'btn primary', disabled: !!state.busy, onClick: actions.savePersona }, state.busy === 'persona' ? '保存中…' : '保存并注入人设')),
    state.personaMsg ? el('div', { className: state.personaMsg.startsWith('✓') ? 'banner ok' : 'banner err', style: { marginTop: '10px', marginBottom: 0 } }, state.personaMsg) : null)

  const tasteCard = el('div', { className: 'card' },
    el('h2', {}, '她的口味偏好'),
    row('爱看的关键词', 'feed 选片打分中权重最高，决定她看待 B 站的视角。', listCtrl(getPath(cfg, ['preferences', 'like']), v => actions.setCfg(['preferences', 'like'], v))),
    row('不爱看的词', '命中后自动降权或排除。', listCtrl(getPath(cfg, ['preferences', 'dislike']), v => actions.setCfg(['preferences', 'dislike'], v))))

  const wins = Array.isArray(getPath(cfg, ['night', 'windows'])) ? getPath(cfg, ['night', 'windows']) : []
  const nums = ['①', '②', '③', '④', '⑤', '⑥', '⑦', '⑧']
  const updWin = (i, patch) => actions.setCfg(['night', 'windows'], wins.map((w, j) => j === i ? { ...w, ...patch } : w), true)
  const delWin = (i) => actions.setCfg(['night', 'windows'], wins.filter((_, j) => j !== i), true)
  const addWin = () => actions.setCfg(['night', 'windows'], [...wins, { start: '20:00', end: '22:00', wakes: 1 }], true)

  const nightCard = el('div', { className: 'card' },
    el('h2', {}, '她的作息与生物钟'),
    el('p', { className: 'card-sub' }, '每个时间窗内随机挑时刻醒来（不整点）。保存作息变更会立即通知后台守护重算计划。'),
    wins.length === 0
      ? el('div', { className: 'row-hint' }, '还没有时间窗，请至少添加一个。')
      : el('div', {}, ...wins.map((w, i) =>
          el('div', { className: 'row' },
            el('div', { className: 'inline' },
              el('span', { className: 'row-hint', style: { minWidth: '18px' } }, nums[i] ?? String(i + 1)),
              el('input', { className: 'input sm', value: w.start ?? '', placeholder: '20:00', onChange: e => updWin(i, { start: e.target.value }) }),
              el('span', { className: 'row-hint' }, '–'),
              el('input', { className: 'input sm', value: w.end ?? '', placeholder: '24:00', onChange: e => updWin(i, { end: e.target.value }) }),
              el('span', { className: 'row-hint' }, '醒来'),
              el('input', { className: 'input xs', type: 'number', min: 1, max: 12, value: w.wakes ?? 1, onChange: e => updWin(i, { wakes: Number(e.target.value) || 1 }) }),
              el('span', { className: 'row-hint' }, '次')),
            el('button', { type: 'button', className: 'btn danger sm', disabled: wins.length <= 1, onClick: () => delWin(i) }, '删除')))),
    el('div', { className: 'inline', style: { margin: '10px 0' } },
      el('button', { type: 'button', className: 'btn', onClick: addWin }, '+ 添加时间窗'),
      el('button', { type: 'button', className: 'btn', disabled: !!state.busy, onClick: () => actions.triggerNight(true) }, '预演手工唤醒（--dry）'),
      el('button', { type: 'button', className: 'btn primary', disabled: !!state.busy, onClick: () => actions.triggerNight(false) }, '立即唤醒一次（--go）')),
    row('今晚不看的概率', '0.3 = 三成概率随机跳过看片（仍写日记）。', textCtrl(getPath(cfg, ['night', 'skipChance']), v => actions.setCfg(['night', 'skipChance'], v), { type: 'number' })),
    row('单次醒来候选视频数', '初筛最多条数，筛完再挑 2–3 条深读。', textCtrl(getPath(cfg, ['night', 'maxVideos']), v => actions.setCfg(['night', 'maxVideos'], v), { type: 'number' })),
    state.triggerOut ? el('pre', { className: 'console-out' }, state.triggerOut) : null)

  return el('div', {}, namingCard, personaCard, tasteCard, nightCard)
}

export function renderInteractTab(state, actions) {
  const cfg = state.cfg
  const shareEnabled = getPath(cfg, ['share', 'enabled']) !== false
  const commentListen = getPath(cfg, ['listen', 'comment']) !== false
  const notifyType = ['none', 'desktop', 'dm', 'webhook', 'command'].includes(cfg.notify?.type) ? cfg.notify.type : 'none'

  const shareCard = el('div', { className: 'card' },
    el('h2', {}, '分享与自主活动'),
    row('允许主动分享', '遇到值得分享的视频时主动发给你。', switchCtrl('允许主动分享', shareEnabled, v => actions.setCfg(['share', 'enabled'], v, true))),
    shareEnabled ? row('分享给我的方式', '私信需与主人互关；公开评论会在视频下 @ 主人。',
      selectCtrl(getPath(cfg, ['share', 'via']) ?? 'dm', [['dm', 'B 站私信（需互关）'], ['comment', '公开评论 @ 我']], v => actions.setCfg(['share', 'via'], v, true))) : null,
    shareEnabled ? row('每日分享上限', '建议 ≤ 3，避免触发平台限流。', textCtrl(getPath(cfg, ['quota', 'shareDaily']) ?? 3, v => actions.setCfg(['quota', 'shareDaily'], v), { type: 'number' })) : null,
    row('疑似 AI 评论检查（试用）', '仅主动 @ 分享时启用，按视频缓存 6 小时，超阈值暂缓并推送。', switchCtrl('疑似 AI 评论检查', !!getPath(cfg, ['share', 'aiCommentGuard']), v => actions.setCfg(['share', 'aiCommentGuard'], v, true))),
    row('允许自主浏览与主动聊天', '唤醒后可追加只读浏览，满足条件时主动私信。', switchCtrl('自主浏览与聊天', !!getPath(cfg, ['life', 'autonomy']), v => actions.setCfg(['life', 'autonomy'], v, true))),
    row('自动写日记', '后台按公开浏览与私人交流分别生成两本日记。', switchCtrl('自动写日记', getPath(cfg, ['diary', 'enabled']) !== false, v => actions.setCfg(['diary', 'enabled'], v, true))),
    row('聊完后补话', '回复主人后几分钟内若有未说完的内容可补一条私信。', switchCtrl('聊完后补话', !!getPath(cfg, ['chat', 'followup']), v => actions.setCfg(['chat', 'followup'], v, true))),
    row('久未联系时主动私信', '安静时段不打扰，有具体话题才开口。', switchCtrl('久未联系私信', !!getPath(cfg, ['chat', 'idle']), v => actions.setCfg(['chat', 'idle'], v, true))),
    row('分享评论收到回复时提醒我', '通过私信提醒（需同时开启评论监听）。', switchCtrl('分享评论提醒', !!getPath(cfg, ['chat', 'shareReply']), v => actions.setCfg(['chat', 'shareReply'], v, true))),
    row('允许自主发公开动态', '本轮看过视频且有公开感想时每日最多发 1 条。', switchCtrl('允许发动态', !!getPath(cfg, ['chat', 'dynamic']), v => actions.setCfg(['chat', 'dynamic'], v, true))))

  const listenCard = el('div', { className: 'card' },
    el('h2', {}, '收件箱监听'),
    row('接收主人的私信', '只认主人这一会话；陌生人一律忽略，无新消息零模型消耗。', switchCtrl('私信监听', !!getPath(cfg, ['listen', 'dm']), v => actions.setCfg(['listen', 'dm'], v, true))),
    row('接收评论区通知', '轮询回复我的 / @ 我的收件箱。', switchCtrl('评论监听', commentListen, v => actions.setCfg(['listen', 'comment'], v, true))),
    commentListen ? row('评论接收范围', '', selectCtrl(getPath(cfg, ['listen', 'scope']) ?? 'both', [['both', '直接回复和 @ 提及'], ['reply', '仅直接回复']], v => actions.setCfg(['listen', 'scope'], v, true))) : null,
    commentListen ? row('只处理主人的评论', '', switchCtrl('仅主人评论', !!getPath(cfg, ['listen', 'onlyOwner']), v => actions.setCfg(['listen', 'onlyOwner'], v, true))) : null,
    commentListen ? row('同一人 30 天内最多回复一次', '防拉锯保护，不对主人限制。', switchCtrl('同人30天限一次', !!getPath(cfg, ['listen', 'oncePerPerson']), v => actions.setCfg(['listen', 'oncePerPerson'], v, true))) : null,
    commentListen ? row('作息窗口外也监听评论', '', switchCtrl('全天监听评论', !!getPath(cfg, ['listen', 'allDay']), v => actions.setCfg(['listen', 'allDay'], v, true))) : null,
    commentListen ? row('响应主人的 @ 总结请求', '通过下方通知渠道发送总结。', switchCtrl('响应@总结', !!getPath(cfg, ['listen', 'mentionSummary']), v => actions.setCfg(['listen', 'mentionSummary'], v, true))) : null)

  const notifyCard = el('div', { className: 'card' },
    el('h2', {}, '日记推送与通知渠道'),
    row('推送新写的公开日记', '私人日记永不推送；仅公开日记提交成功后推送一次。', switchCtrl('推送公开日记', getPath(cfg, ['diary', 'push']) !== false, v => actions.setCfg(['diary', 'push'], v, true))),
    row('通知渠道', '本轮小结、报备与公开日记摘要将发到这里。',
      selectCtrl(notifyType, [
        ['none', '不推送'],
        ['desktop', 'Windows 桌面通知'],
        ['dm', 'B 站私信'],
        ['webhook', 'Webhook（飞书 / 钉钉 / 企微 / QQ）'],
        ['command', '自定义 Windows 命令'],
      ], v => actions.setCfg(['notify', 'type'], v, true))),
    notifyType === 'webhook' ? row('Webhook 地址', '按域名自动适配飞书/钉钉/企业微信/QQ 机器人报文。', textCtrl(getPath(cfg, ['notify', 'url']), v => actions.setCfg(['notify', 'url'], v), { wide: true, placeholder: 'https://open.feishu.cn/open-apis/bot/v2/hook/…' })) : null,
    notifyType === 'webhook' ? row('Webhook 模板', '', selectCtrl(getPath(cfg, ['notify', 'template']) ?? 'text', [['text', '纯文本'], ['markdown', 'Markdown']], v => actions.setCfg(['notify', 'template'], v, true))) : null,
    notifyType === 'command' ? row('可执行文件路径', '消息自动作为最后一个参数传入（不经过 shell，防注入）。', textCtrl(getPath(cfg, ['notify', 'cmd']), v => actions.setCfg(['notify', 'cmd'], v), { wide: true, placeholder: 'C:\\path\\to\\node.exe' })) : null,
    notifyType === 'command' ? row('附加参数（JSON 数组）', '可留空；例如 ["C:/path/to/send.js"]',
      textCtrl(JSON.stringify(getPath(cfg, ['notify', 'args']) ?? []), v => { try { const parsed = JSON.parse(v); if (Array.isArray(parsed)) actions.setCfg(['notify', 'args'], parsed) } catch {} }, { wide: true })) : null,
    el('div', { className: 'inline', style: { marginTop: '10px' } },
      el('button', { type: 'button', className: 'btn', disabled: !!state.busy, onClick: actions.notifyTest }, state.busy === 'notify' ? '测试发送中…' : '保存并发送测试通知')),
    state.notifyOut ? el('pre', { className: 'console-out' }, state.notifyOut) : null)

  return el('div', {}, shareCard, listenCard, notifyCard)
}

export function renderPendingTab(state, actions) {
  const items = state.pending ?? []
  return el('div', { className: 'card' },
    el('div', { className: 'card-head' },
      el('h2', {}, `待审回复队列（${items.length} 条）`),
      el('button', { type: 'button', className: 'btn', disabled: !!state.busy, onClick: actions.refreshPending }, '刷新队列')),
    el('p', { className: 'card-sub' }, '大鲸鱼回复陌生人之前会先把草稿放在这里，由你点击「批准发出」才真的发送；点击「删除」也会记录反馈。'),
    state.pendingMsg ? el('div', { className: state.pendingMsg.startsWith('✓') ? 'banner ok' : 'banner err' }, state.pendingMsg) : null,
    items.length === 0
      ? el('div', { className: 'row-hint', style: { padding: '16px 0' } }, '队列为空，暂无待审核回复。')
      : el('div', {}, ...items.map(x => el('div', { className: 'item-card' },
          el('div', { className: 'inline', style: { justifyContent: 'space-between' } },
            el('div', {},
              el('strong', {}, `→ ${x.who || '对方'}`),
              el('span', { className: 'pill', style: { marginLeft: '8px' } }, String(x.at ?? '').slice(5, 16).replace('T', ' '))),
            el('div', { className: 'inline' },
              el('button', { type: 'button', className: 'btn primary sm', disabled: !!state.busy, onClick: () => actions.approvePending(x.id) }, state.busy === 'approve:' + x.id ? '发送中…' : '批准发出'),
              el('button', { type: 'button', className: 'btn danger sm', disabled: !!state.busy, onClick: () => actions.rejectPending(x.id) }, '删除'))),
          x.src ? el('div', { className: 'row-hint', style: { marginTop: '6px' } }, `对方说：${String(x.src).slice(0, 120)}`) : null,
          el('div', { style: { marginTop: '6px' } }, `拟回复：${x.message}`)))))
}

function workerPill(label, st) {
  const s = st?.status || 'idle'
  const cls = s === 'running' ? 'info' : s === 'error' ? 'err' : s === 'unavailable' ? 'warn' : 'ok'
  const txt = { idle: '待命', running: '运行中', error: '异常', unavailable: '未连接', disabled: '已关闭' }[s] || s
  return el('span', { className: `pill ${cls}` }, el('span', { className: 'dot' }), `${label}：${txt}`)
}

function renderDepCard(card, state, actions) {
  const statusMap = {
    ok: { cls: 'ok', label: '已就绪' },
    optional: { cls: 'warn', label: '可选未装' },
    error: { cls: 'err', label: '需处理' },
  }
  const st = statusMap[card.status] || statusMap.error
  const installingFfmpeg = state.busy === 'ffmpeg'

  let actionBtn = null
  if (card.action === 'install_ffmpeg') {
    actionBtn = el('button', {
      type: 'button',
      className: 'btn primary sm',
      disabled: !!state.busy,
      onClick: actions.installFfmpeg,
    }, installingFfmpeg ? '下载校验 ffmpeg 中（约 1 分钟）…' : '一键安装 ffmpeg')
  } else if (card.action === 'goto_login') {
    actionBtn = el('button', {
      type: 'button',
      className: 'btn primary sm',
      disabled: !!state.busy,
      onClick: () => actions.switchTab('account'),
    }, '前往扫码登录')
  }

  return el('div', { className: `dep-card ${card.status || 'error'}` },
    el('div', { className: 'dep-head' },
      el('span', { className: 'dep-name' }, card.name),
      el('span', { className: `pill ${st.cls}` }, el('span', { className: 'dot' }), st.label)),
    card.version ? el('div', { className: 'dep-ver' }, card.version) : null,
    card.location ? el('div', { className: 'dep-path', title: card.location }, card.location) : null,
    card.detail ? el('div', { className: 'dep-detail' }, card.detail) : null,
    card.fix ? el('div', { className: 'dep-fix' }, card.fix) : null,
    actionBtn ? el('div', { className: 'dep-actions' }, actionBtn) : null)
}

export function renderRuntimeTab(state, actions) {
  const st = state.status ?? {}
  const cfg = state.cfg
  const lastWake = st.delivery?.lastWake
  const labels = {
    accepted: 'Antigravity 已接受投递',
    unconfirmed: '结果未确认（本次不重投）',
    dispatching: '等待宿主确认',
    failed: '投递失败',
  }

  const overviewCard = el('div', { className: 'card' },
    el('div', { className: 'card-head' },
      el('h2', {}, '运行概览与后台 Worker'),
      el('button', { type: 'button', className: 'btn', disabled: !!state.busy, onClick: actions.refreshStatus }, state.busy === 'status' ? '刷新中…' : '刷新状态')),
    el('div', { className: 'grid-2' },
      el('div', { className: 'stat-tile' },
        el('div', { className: 'stat-k' }, '后台守护进程'),
        el('div', { className: 'stat-v' }, st.sidecarRunning ? `运行中（PID ${st.sidecarPid}）` : '未连接（请在插件页确认已开启）')),
      el('div', { className: 'stat-tile' },
        el('div', { className: 'stat-k' }, '今日分享 / 评论'),
        el('div', { className: 'stat-v' }, `${st.shares ?? 0} / ${st.sharesMax ?? 3} 次分享 · ${st.commentsToday ?? 0} 条发言`)),
      el('div', { className: 'stat-tile' },
        el('div', { className: 'stat-k' }, '今日作息计划'),
        el('div', { className: 'stat-v' }, st.plan ? `${st.plan.action} · ${st.plan.atText || '-'}（已醒 ${st.plan.wakes} 次）` : '尚无今日计划')),
      el('div', { className: 'stat-tile' },
        el('div', { className: 'stat-k' }, '独立数据目录'),
        el('div', { className: 'stat-v mono' }, st.dataDir || '%USERPROFILE%\\.antigravity-bili-whale'))),
    el('div', { className: 'worker-pills' },
      workerPill('记忆归纳', st.formation),
      workerPill('心情分析', st.affectWorker),
      workerPill('自动日记', st.diaryWorker),
      workerPill('社交判断', st.socialWorker)),
    el('div', { className: 'stack', style: { marginTop: '10px' } },
      el('div', { className: 'row-hint' }, `调度阶段：${st.scheduler?.activeRun?.stage || st.scheduler?.status || '暂无心跳'} · 最近心跳：${st.scheduler?.lastTickAt ? new Date(st.scheduler.lastTickAt).toLocaleString('zh-CN') : '尚未记录'}`),
      el('div', { className: 'row-hint' }, lastWake ? `上次唤醒投递：${labels[lastWake.status] || lastWake.status} · ${new Date(lastWake.updatedAt).toLocaleString('zh-CN')}` : '尚无唤醒投递记录'),
      st.scheduler?.lastError ? el('div', { className: 'banner err' }, '最近调度错误：' + st.scheduler.lastError.message) : null,
      st.delivery?.unconfirmed > 0 ? el('div', { className: 'banner warn' }, `${st.delivery.unconfirmed} 条投递待核查，请先检查 Antigravity 会话列表，勿重复发送。`) : null))

  const deps = state.depsData
  const cards = deps?.cards ?? []
  const errorCount = cards.filter(c => c.status === 'error').length
  const optionalCount = cards.filter(c => c.status === 'optional').length
  const summaryPill = !deps
    ? el('span', { className: 'pill' }, state.busy === 'deps' ? '体检中…' : '等待体检')
    : errorCount === 0
      ? el('span', { className: 'pill ok' }, el('span', { className: 'dot' }), optionalCount > 0 ? `核心依赖已就绪（${optionalCount} 项可选）` : '全部依赖已就绪')
      : el('span', { className: 'pill err' }, el('span', { className: 'dot' }), `${errorCount} 项需要处理`)

  const depsCard = el('div', { className: 'card' },
    el('div', { className: 'card-head' },
      el('div', { className: 'inline' },
        el('h2', {}, '环境与依赖体检'),
        summaryPill),
      el('div', { className: 'inline' },
        el('button', { type: 'button', className: 'btn primary', disabled: !!state.busy, onClick: actions.runDeps }, state.busy === 'deps' ? '体检中…' : '重新体检'),
        el('button', { type: 'button', className: 'btn', disabled: !!state.busy, onClick: actions.installFfmpeg }, state.busy === 'ffmpeg' ? '下载安装 ffmpeg 中…' : '安装 / 更新 ffmpeg'))),
    el('p', { className: 'card-sub' }, '自动检测 Node.js 版本、ffmpeg（视频抽帧看画面）、大鲸鱼 B 站登录态、后台守护与隔离目录权限。所有扩展组件均安装在独立数据目录，不污染系统 PATH。'),
    state.ffmpegMsg ? el('div', { className: `banner ${state.ffmpegMsg.kind}` }, state.ffmpegMsg.text) : null,
    state.depsError ? el('div', { className: 'banner err' }, state.depsError) : null,
    cards.length > 0
      ? el('div', { className: 'deps-grid' }, ...cards.map(c => renderDepCard(c, state, actions)))
      : el('div', { className: 'row-hint', style: { padding: '12px 0' } }, state.busy === 'deps' ? '正在逐项检测运行环境与版本信息…' : '点击「重新体检」查看各项依赖版本与健康状态。'),
    deps?.items?.length
      ? el('details', { className: 'fold' },
          el('summary', {}, '展开原始体检详情（排障用）'),
          el('pre', { className: 'console-out' }, JSON.stringify({ ok: deps.ok, node: deps.node, scheduler: deps.scheduler, items: deps.items }, null, 2)))
      : null)

  const advCard = el('div', { className: 'card' },
    el('h2', {}, '会话成本与隔离目录'),
    row('会话轮换天数', '0 = 不轮换；开启后在空闲时开新会话，旧会话保留。', textCtrl(getPath(cfg, ['sessionRotateDays']) ?? 0, v => actions.setCfg(['sessionRotateDays'], v), { type: 'number' })),
    row('每会话减少重复人设', '默认开启；成功投递后去重，人设变更或重启后重新注入。', switchCtrl('人设去重', getPath(cfg, ['personaOncePerSession']) !== false, v => actions.setCfg(['personaOncePerSession'], v, true))),
    row('专用会话目录覆盖（可选）', '留空使用独立默认目录 %USERPROFILE%\\.antigravity-bili-whale\\whale-work。', textCtrl(getPath(cfg, ['home']) ?? '', v => actions.setCfg(['home'], v), { wide: true })))

  return el('div', {}, overviewCard, depsCard, advCard)
}
