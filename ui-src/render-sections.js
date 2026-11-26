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
    else if (k === 'maxLength') node.maxLength = Number(v)
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
      checked: Boolean(checked),
      disabled,
      onChange: (e) => onChange(e.target.checked),
    }),
    el('span', { className: 'row-hint' }, checked ? '已开启' : '未开启'))
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

export function selectCtrl(value, options, onChange) {
  return el('select', {
    className: 'select',
    value: String(value ?? ''),
    onChange: (e) => onChange(e.target.value),
  }, options.map(([val, text]) => el('option', { value: String(val), selected: String(value ?? '') === String(val) }, text)))
}

const MAX_PERSONA_CHARS = 4000
const MAX_LIKE_TAGS = 6
const MAX_DISLIKE_TAGS = 12
const LIKE_SUGGESTIONS = ['AI 工具', '科技新闻', '编程开发', '效率软件', '数码评测', '科普', '猫咪', '纪录片', '独立游戏', '影视解说']
const DISLIKE_SUGGESTIONS = ['带货', '擦边', '标题党', '纯搬运', '营销号', '引战', '剧透']

function tagEditorCtrl({
  items,
  max,
  kind,
  draftValue,
  onDraftChange,
  onChange,
  suggestions,
  placeholder,
}) {
  const list = Array.isArray(items) ? items.filter(Boolean) : []
  const atMax = list.length >= max

  const addTags = (raw) => {
    const parts = String(raw ?? '').split(/[,，、\n]/).map(s => s.trim()).filter(Boolean)
    if (!parts.length) return
    const next = [...list]
    for (const p of parts) {
      if (next.length >= max) break
      if (!next.includes(p)) next.push(p)
    }
    onDraftChange('')
    onChange(next)
  }

  const removeTag = (tag) => onChange(list.filter(t => t !== tag))

  const inputNode = el('input', {
    className: 'input',
    style: { flex: '1', minWidth: '170px' },
    value: draftValue ?? '',
    disabled: atMax,
    placeholder: atMax ? `已达上限（最多 ${max} 个），请先删除不需要的标签` : placeholder,
    onInput: (e) => onDraftChange(e.target.value),
    onKeydown: (e) => {
      if (e.key === 'Enter') {
        e.preventDefault()
        addTags(e.target.value)
      }
    },
  })

  return el('div', { className: 'tag-editor' },
    el('div', { className: 'tag-chips' },
      list.length === 0
        ? el('span', { className: 'row-hint' }, '暂未添加标签，可在下方输入或点击快捷标签添加。')
        : list.map(tag => el('span', { className: `tag-chip ${kind}` },
            tag,
            el('button', {
              type: 'button',
              className: 'tag-chip-rm',
              title: `移除「${tag}」`,
              'aria-label': `移除 ${tag}`,
              onClick: () => removeTag(tag),
            }, '×')))),
    el('div', { className: 'tag-input-row' },
      inputNode,
      el('button', {
        type: 'button',
        className: 'btn sm',
        disabled: atMax,
        onClick: () => addTags(inputNode.value),
      }, '+ 添加'),
      el('span', { className: 'pill ' + (atMax ? 'warn' : '') }, `已选 ${list.length} / ${max}`)),
    el('div', { className: 'tag-suggest' },
      el('span', { className: 'tag-suggest-label' }, '快捷添加：'),
      ...suggestions.map(sug => {
        const exists = list.includes(sug)
        return el('button', {
          type: 'button',
          className: 'tag-suggest-btn',
          disabled: exists || atMax,
          onClick: () => addTags(sug),
        }, exists ? `✓ ${sug}` : `+ ${sug}`)
      })))
}

/**
 * Tab 1：大鲸鱼与主人
 * - 清晰拆分为「大鲸鱼（B 站账号与扫码登录）」与「主人信息（含 UID 与昵称一键核验）」。
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

  const oc = state.ownerCheck
  const ownerCard = el('div', { className: 'card' },
    el('div', { className: 'card-head' },
      el('h2', {}, '主人信息'),
      el('button', {
        type: 'button',
        className: 'btn',
        disabled: !!state.busy || !String(getPath(cfg, ['owner', 'mid']) ?? '').trim(),
        onClick: actions.verifyOwner,
      }, state.busy === 'verify_owner' ? '正在查询 B 站…' : '检查 UID 与昵称是否对应')),
    el('p', { className: 'card-sub' }, '填写你自己的 B 站 UID 和昵称，大鲸鱼据此识别「谁是主人」、定向私信与 @ 分享。填写 UID 后可点击右上角按钮核验是否与 B 站实际账号一致。'),
    row('主人 UID（mid）', '用来识别「谁是你」、谁回复了她、谁给她点了赞。', textCtrl(getPath(cfg, ['owner', 'mid']), v => {
      state.ownerCheck = null
      state.ownerCheckErr = ''
      actions.setCfg(['owner', 'mid'], v)
    }, { placeholder: '例如 12345678' })),
    row('主人 B 站昵称', '@ 分享或写日记提到你时使用（可只填 UID 再点检查自动填入）。', textCtrl(getPath(cfg, ['owner', 'name']), v => {
      state.ownerCheck = null
      state.ownerCheckErr = ''
      actions.setCfg(['owner', 'name'], v)
    }, { placeholder: '你的 B 站昵称' })),
    state.ownerCheckErr
      ? el('div', { className: 'banner err', style: { marginTop: '10px', marginBottom: 0 } }, state.ownerCheckErr)
      : null,
    oc
      ? el('div', {
          className: 'banner ' + (oc.matched === true ? 'ok' : oc.matched === false ? 'warn' : 'ok'),
          style: { marginTop: '10px', marginBottom: 0, display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '8px' },
        },
        el('span', {}, oc.detail + (oc.sign ? `\n签名：${oc.sign}` : '')),
        oc.matched !== true && oc.actualName
          ? el('button', {
              type: 'button',
              className: 'btn primary sm',
              onClick: () => actions.applyOwnerName(oc.actualName),
            }, oc.matched === false ? `同步为「${oc.actualName}」` : `一键填入「${oc.actualName}」`)
          : null)
      : null)

  return el('div', {}, whaleCard, ownerCard)
}

/**
 * Tab 2：人设与作息
 * - 基础称呼（默认角色名「大鲸鱼」）、人设正文（硬上限 4000 字）、可视化口味标签（最多 6 个）与作息生物钟。
 */
export function renderPersonaTab(state, actions) {
  const cfg = state.cfg
  const personaLen = state.personaText.length
  const personaOver = personaLen > MAX_PERSONA_CHARS

  const namingCard = el('div', { className: 'card' },
    el('h2', {}, '基础称呼'),
    el('p', { className: 'card-sub' }, '决定大鲸鱼的名字、怎么称呼你以及她怎么自称。'),
    row('角色名', '她怎么被称呼（默认「大鲸鱼」）。', textCtrl(getPath(cfg, ['persona', 'name']) || '大鲸鱼', v => actions.setCfg(['persona', 'name'], v), { placeholder: '大鲸鱼' })),
    row('她怎么称呼你', '例如「主人」或你的专属称呼。', textCtrl(getPath(cfg, ['persona', 'ownerTitle']), v => actions.setCfg(['persona', 'ownerTitle'], v))),
    row('她怎么自称', '例如「我」/「人家」。', textCtrl(getPath(cfg, ['persona', 'selfClaim']), v => actions.setCfg(['persona', 'selfClaim'], v))))

  const personaCard = el('div', { className: 'card' },
    el('h2', {}, '她的人设正文（仅对大鲸鱼生效，不影响日常编程对话）'),
    el('p', { className: 'card-sub' }, `保存位置：${state.personaPath || '%USERPROFILE%\\.antigravity-bili-whale\\persona.md'}。建议写 300–1500 字（精炼表达模型遵守度最高），前后端硬上限 ${MAX_PERSONA_CHARS} 字。`),
    el('textarea', {
      className: 'textarea',
      rows: 9,
      maxLength: MAX_PERSONA_CHARS,
      placeholder: '例如：\n她的性格与说话腔调（偏短句、自然随和、不端着…）\n她的背景来历与日常小习惯…\n她平时在意的事…\n她的原则与底线（绝对不会做什么）…',
      value: state.personaText,
      onInput: (e) => {
        state.personaText = e.target.value
        const over = state.personaText.length > MAX_PERSONA_CHARS
        const counter = document.getElementById('persona-counter')
        if (counter) {
          counter.className = over ? 'row-hint counter-err' : 'row-hint'
          counter.textContent = over
            ? `当前 ${state.personaText.length} / ${MAX_PERSONA_CHARS} 字（已超限，请先删减 ${state.personaText.length - MAX_PERSONA_CHARS} 字）`
            : `当前 ${state.personaText.length} / ${MAX_PERSONA_CHARS} 字`
        }
        const btn = document.getElementById('persona-save-btn')
        if (btn) btn.disabled = !!state.busy || over
      },
    }),
    el('div', { className: 'inline', style: { marginTop: '10px', justifyContent: 'space-between' } },
      el('span', { id: 'persona-counter', className: personaOver ? 'row-hint counter-err' : 'row-hint' },
        personaOver
          ? `当前 ${personaLen} / ${MAX_PERSONA_CHARS} 字（已超限，请先删减 ${personaLen - MAX_PERSONA_CHARS} 字）`
          : `当前 ${personaLen} / ${MAX_PERSONA_CHARS} 字（磁盘 ${state.personaBytes} 字节）`),
      el('button', {
        id: 'persona-save-btn',
        type: 'button',
        className: 'btn primary',
        disabled: !!state.busy || personaOver,
        onClick: actions.savePersona,
      }, state.busy === 'persona' ? '保存中…' : '保存并注入人设')),
    state.personaMsg ? el('div', { className: state.personaMsg.startsWith('✓') ? 'banner ok' : 'banner err', style: { marginTop: '10px', marginBottom: 0 } }, state.personaMsg) : null)

  const tasteCard = el('div', { className: 'card' },
    el('h2', {}, '她的口味偏好'),
    el('p', { className: 'card-sub' }, '决定大鲸鱼主动去 B 站搜什么、挑什么视频看，以及主动避开哪些内容。修改后记得点右上角「保存配置」。'),
    row(
      '喜欢的类型（最多 6 个）',
      '大鲸鱼每次醒来会按这 6 个以内的主题主动去 B 站搜索，并在选片打分里给最高权重；上限 6 个是为了避免搜索过密触发 B 站限流。',
      tagEditorCtrl({
        items: getPath(cfg, ['preferences', 'like']),
        max: MAX_LIKE_TAGS,
        kind: 'like',
        draftValue: state.likeTagDraft,
        onDraftChange: (v) => { state.likeTagDraft = v },
        onChange: (next) => actions.setCfg(['preferences', 'like'], next, true),
        suggestions: LIKE_SUGGESTIONS,
        placeholder: '输入喜欢的类型后按回车，如 AI 工具',
      })),
    row(
      '不喜欢的类型（屏蔽，最多 12 个）',
      '视频标题或标签命中这些词时会自动降权或直接排除。',
      tagEditorCtrl({
        items: getPath(cfg, ['preferences', 'dislike']),
        max: MAX_DISLIKE_TAGS,
        kind: 'dislike',
        draftValue: state.dislikeTagDraft,
        onDraftChange: (v) => { state.dislikeTagDraft = v },
        onChange: (next) => actions.setCfg(['preferences', 'dislike'], next, true),
        suggestions: DISLIKE_SUGGESTIONS,
        placeholder: '输入不想看的类型后按回车，如 带货',
      })))

  const wins = Array.isArray(getPath(cfg, ['night', 'windows'])) ? getPath(cfg, ['night', 'windows']) : []
  const nums = ['①', '②', '③', '④', '⑤', '⑥', '⑦', '⑧']
  const updWin = (i, patch) => actions.setCfg(['night', 'windows'], wins.map((w, j) => j === i ? { ...w, ...patch } : w), true)
  const delWin = (i) => actions.setCfg(['night', 'windows'], wins.filter((_, j) => j !== i), true)
  const addWin = () => actions.setCfg(['night', 'windows'], [...wins, { start: '20:00', end: '22:00', wakes: 1 }], true)

  const rawSkip = Number(getPath(cfg, ['night', 'skipChance']) ?? 0.2)
  const snappedSkip = Number(Math.min(0.8, Math.max(0, Math.round((Number.isFinite(rawSkip) ? rawSkip : 0.2) * 5) / 5)).toFixed(1))
  const curMinGap = Math.min(240, Math.max(10, Math.floor(Number(getPath(cfg, ['night', 'minGapMin']) ?? 10) || 10)))
  const curMaxVideos = Math.min(10, Math.max(1, Math.floor(Number(getPath(cfg, ['night', 'maxVideos']) ?? 5) || 5)))
  const curDeepMax = Math.min(3, curMaxVideos, Math.max(1, Math.floor(Number(getPath(cfg, ['night', 'deepWatchMax']) ?? 3) || 3)))
  const totalConfiguredWakes = wins.reduce((sum, w) => sum + (Number(w?.wakes) || 1), 0)

  const nightCard = el('div', { className: 'card' },
    el('h2', {}, '她的作息与生物钟'),
    el('p', { className: 'card-sub' }, '每个时间窗内随机挑时刻醒来（不卡整点），每醒来 1 次或按概率跳过 1 次均计 1 次机会。相邻两次醒来强制遵守下方最小间隔（硬下限，窗口内排不下会自动少醒），全天所有窗口合计最多 12 次。保存配置后会立即通知后台守护重算计划。'),
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
              el('input', { className: 'input xs', type: 'number', min: 1, max: 12, value: w.wakes ?? 1, onChange: e => updWin(i, { wakes: Math.min(12, Math.max(1, Number(e.target.value) || 1)) }) }),
              el('span', { className: 'row-hint' }, '次')),
            el('button', { type: 'button', className: 'btn danger sm', disabled: wins.length <= 1, onClick: () => delWin(i) }, '删除')))),
    totalConfiguredWakes > 12
      ? el('div', { className: 'banner warn', style: { marginTop: '8px' } }, `当前所有窗口醒来次数合计 ${totalConfiguredWakes} 次，超过每日上限 12 次；实际每天最多只会执行 12 次。`)
      : null,
    el('div', { className: 'inline', style: { margin: '10px 0 6px' } },
      el('button', { type: 'button', className: 'btn', onClick: addWin }, '+ 添加时间窗')),
    row(
      '两次醒来最小间隔',
      '硬性下限（默认 10 分钟）：就算短窗口里设了很多次，也绝不压缩最小间隔；排不下的次数自动放弃，另含每轮结束后 8 分钟冷却。',
      selectCtrl(
        [10, 15, 30, 60, 120].includes(curMinGap) ? curMinGap : 10,
        [
          ['10', '10 分钟（默认）'],
          ['15', '15 分钟'],
          ['30', '30 分钟'],
          ['60', '60 分钟（1 小时）'],
          ['120', '120 分钟（2 小时）'],
        ],
        v => actions.setCfg(['night', 'minGapMin'], Number(v), true),
      )),
    row(
      '每次醒来不看的概率',
      '0% = 每次醒来必刷视频；最高 80% = 大部分时候跳过看片（不设 100% 以免永远不看）。跳过只消耗本次机会，不影响自动写日记。',
      selectCtrl(
        String(snappedSkip),
        [
          ['0', '0%（每次必看，从不跳过）'],
          ['0.2', '20%（偶尔跳过，推荐）'],
          ['0.4', '40%（有时跳过）'],
          ['0.6', '60%（多数时候跳过）'],
          ['0.8', '80%（很少看片，最高档）'],
        ],
        v => actions.setCfg(['night', 'skipChance'], Number(v), true),
      )),
    row(
      '单次醒来候选视频数',
      '每次醒来初筛最多捞出几条候选视频供她挑选（范围 1–10 条；数字越大面越广，越小越快）。',
      selectCtrl(
        String(curMaxVideos),
        Array.from({ length: 10 }, (_, idx) => {
          const n = idx + 1
          return [String(n), n === 5 ? `${n} 条（默认）` : `${n} 条`]
        }),
        v => {
          const nextMax = Number(v)
          actions.setCfg(['night', 'maxVideos'], nextMax, false)
          if (curDeepMax > nextMax) actions.setCfg(['night', 'deepWatchMax'], nextMax, false)
          actions.rerender()
        },
      )),
    row(
      '单次最感兴趣深看数',
      '从上方候选视频中挑最感兴趣的最多几条完整看字幕、弹幕、评论与画面（范围 1–3 条，且不超过候选数）。',
      selectCtrl(
        String(curDeepMax),
        [
          ['1', '最多 1 条（最省配额）'],
          ['2', '最多 2 条（均衡）'],
          ['3', '最多 3 条（默认上限）'],
        ].filter(([val]) => Number(val) <= curMaxVideos),
        v => actions.setCfg(['night', 'deepWatchMax'], Number(v), true),
      )))

  return el('div', {}, namingCard, personaCard, tasteCard, nightCard)
}

/**
 * Tab 5：分享与监听
 * - 重构为 4 组清晰独立的卡片，所有开关默认均不勾选（false），按需开启。
 */
export function renderInteractTab(state, actions) {
  const cfg = state.cfg
  const shareEnabled = getPath(cfg, ['share', 'enabled']) === true
  const dmListen = getPath(cfg, ['listen', 'dm']) === true
  const commentListen = getPath(cfg, ['listen', 'comment']) === true
  const diaryEnabled = getPath(cfg, ['diary', 'enabled']) === true
  const notifyType = ['none', 'desktop', 'dm', 'webhook', 'command'].includes(cfg.notify?.type) ? cfg.notify.type : 'none'

  const proactiveCard = el('div', { className: 'card' },
    el('h2', {}, '一、主动分享与公开表达'),
    el('p', { className: 'card-sub' }, '控制大鲸鱼看完视频后，能否主动分享给你、发公开动态或自行扩展浏览（默认均不勾选，按需开启）。'),
    row('允许主动分享视频给主人', '刷到她觉得特别值得分享的视频时，主动把视频发给你。',
      switchCtrl('允许主动分享视频给主人', shareEnabled, v => actions.setCfg(['share', 'enabled'], v, true))),
    shareEnabled
      ? el('div', { className: 'sub-block' },
          row('分享方式', '私信需与主人互关；公开评论会在该视频下方 @ 主人。',
            selectCtrl(getPath(cfg, ['share', 'via']) ?? 'dm', [['dm', 'B 站私信（需互关）'], ['comment', '视频评论区 @ 主人']], v => actions.setCfg(['share', 'via'], v, true))),
          row('每日分享上限', '建议 ≤ 3 条，避免触发平台限流。',
            textCtrl(getPath(cfg, ['quota', 'shareDaily']) ?? 3, v => actions.setCfg(['quota', 'shareDaily'], v), { type: 'number' })),
          row('公开 @ 分享前检查疑似 AI 评论（试用）', '仅在评论区 @ 主人前抽查热评，避免在疑似 AI 刷屏区发言。',
            switchCtrl('疑似 AI 评论检查', getPath(cfg, ['share', 'aiCommentGuard']) === true, v => actions.setCfg(['share', 'aiCommentGuard'], v, true))))
      : null,
    row('允许自主发 B 站公开动态', '本轮看过视频且有公开感想时，每日最多发 1 条公开动态。',
      switchCtrl('允许发动态', getPath(cfg, ['chat', 'dynamic']) === true, v => actions.setCfg(['chat', 'dynamic'], v, true))),
    row('允许自主扩展只读浏览', '每次作息唤醒结束后，可自行追加少量只读探索浏览（不额外发言）。',
      switchCtrl('允许自主扩展浏览', getPath(cfg, ['life', 'autonomy']) === true, v => actions.setCfg(['life', 'autonomy'], v, true))))

  const dmCard = el('div', { className: 'card' },
    el('h2', {}, '二、与主人的私信互动'),
    el('p', { className: 'card-sub' }, '仅识别「大鲸鱼与主人」中配置的主人账号，陌生人私信一律忽略；无新消息时不消耗模型配额。'),
    row('监听主人的 B 站私信', '定时检查你发给大鲸鱼的私信，收到后自动回复。',
      switchCtrl('监听主人私信', dmListen, v => actions.setCfg(['listen', 'dm'], v, true))),
    row('聊完后可补发一条后续私信', '回复完你的私信几分钟内，若有没说完的补充想法可再发一句。',
      switchCtrl('聊完后补话', getPath(cfg, ['chat', 'followup']) === true, v => actions.setCfg(['chat', 'followup'], v, true))),
    row('久未联系时主动私信打招呼', '仅在非安静时段且有具体话题时主动开口，不无故打扰。',
      switchCtrl('久未联系私信', getPath(cfg, ['chat', 'idle']) === true, v => actions.setCfg(['chat', 'idle'], v, true))))

  const commentCard = el('div', { className: 'card' },
    el('h2', {}, '三、B 站评论区与 @ 通知监听'),
    el('p', { className: 'card-sub' }, '轮询 B 站收件箱里的「回复我的」和「@ 我的」通知。回复陌生人会先写入「待审回复」队列由你批准。'),
    row('开启评论区与 @ 通知监听', '总开关：开启后才会定时拉取评论回复与 @ 提及通知。',
      switchCtrl('评论区监听', commentListen, v => actions.setCfg(['listen', 'comment'], v, true))),
    commentListen
      ? el('div', { className: 'sub-block' },
          row('通知监听范围', '决定同时监听回复和 @，还是只看直接回复。',
            selectCtrl(getPath(cfg, ['listen', 'scope']) ?? 'both', [['both', '直接回复 + @ 提及'], ['reply', '仅直接回复']], v => actions.setCfg(['listen', 'scope'], v, true))),
          row('仅处理主人的评论与 @', '勾选后彻底忽略陌生人的评论回复，只理会主人账号。',
            switchCtrl('仅处理主人评论', getPath(cfg, ['listen', 'onlyOwner']) === true, v => actions.setCfg(['listen', 'onlyOwner'], v, true))),
          row('响应主人的 @ 看片 / 总结请求', '你在视频评论区 @ 她看片或总结时自动响应；具体时长规则可在「视频观看设置」中调整。',
            el('div', { className: 'inline' },
              switchCtrl('响应 @ 总结请求', getPath(cfg, ['listen', 'mentionSummary']) === true, v => actions.setCfg(['listen', 'mentionSummary'], v, true)),
              el('button', { type: 'button', className: 'btn sm', onClick: () => actions.switchTab('watch') }, '设置时长规则'))),
          row('分享评论收到新回复时私信提醒主人', '大鲸鱼发出的分享评论下面有新回复时，私信提醒你去看。',
            switchCtrl('分享评论提醒', getPath(cfg, ['chat', 'shareReply']) === true, v => actions.setCfg(['chat', 'shareReply'], v, true))),
          row('同一陌生人 30 天内最多回复一次', '防拉锯保护，避免和评论区陌生人来回刷楼（不对主人限制）。',
            switchCtrl('同人30天限一次', getPath(cfg, ['listen', 'oncePerPerson']) === true, v => actions.setCfg(['listen', 'oncePerPerson'], v, true))),
          row('作息时间窗外也持续监听评论', '不勾选则仅在「人设与作息」设定的时间窗内轮询评论收件箱。',
            switchCtrl('全天监听评论', getPath(cfg, ['listen', 'allDay']) === true, v => actions.setCfg(['listen', 'allDay'], v, true))))
      : null)

  const diaryNotifyCard = el('div', { className: 'card' },
    el('h2', {}, '四、自动日记与消息通知推送'),
    el('p', { className: 'card-sub' }, '配置日记自动记录，以及本轮小结、公开日记摘要、待审提醒发到哪里。'),
    row('自动写日记（公开 + 私人两本）', '后台根据公开浏览和与主人的私人交流分别记录两本日记。',
      switchCtrl('自动写日记', diaryEnabled, v => actions.setCfg(['diary', 'enabled'], v, true))),
    diaryEnabled
      ? el('div', { className: 'sub-block' },
          row('新公开日记写完后推送给主人', '私人日记永不外推；仅公开日记生成完成后通过下方渠道推送一次。',
            switchCtrl('推送公开日记', getPath(cfg, ['diary', 'push']) === true, v => actions.setCfg(['diary', 'push'], v, true))))
      : null,
    row('通知推送渠道', '本轮观看小结、待审回复提醒与公开日记摘要将发到这里。',
      selectCtrl(notifyType, [
        ['none', '不推送（默认）'],
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

  return el('div', {}, proactiveCard, dmCard, commentCard, diaryNotifyCard)
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
