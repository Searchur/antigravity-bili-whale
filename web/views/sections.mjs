/**
 * 控制台基础 DOM 组件辅助函数（元素构造、表单行、徽章、横幅、标签编辑器）与 Tab 1/2/5/7 视图渲染。
 */
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

export function statusPill(kind, text) {
  const cls = ['pill', kind || ''].filter(Boolean).join(' ')
  return el('span', { className: cls }, kind ? el('span', { className: 'dot' }) : null, text)
}

export function metaPill(text, kind = '') {
  const cls = ['pill', kind || ''].filter(Boolean).join(' ')
  return el('span', { className: cls }, text)
}

export function banner(kind, content, { variant = '', action = null } = {}) {
  const cls = ['banner', kind || 'info', variant || '', action ? 'has-action' : ''].filter(Boolean).join(' ')
  if (action) {
    return el('div', { className: cls }, typeof content === 'string' ? el('span', {}, content) : content, action)
  }
  return el('div', { className: cls }, content)
}

export function renderExportResult(info, actions) {
  if (!info || !info.filePath) return null
  const sizeKb = Number.isFinite(info.bytes) ? `（${(info.bytes / 1024).toFixed(1)} KB）` : ''
  return el('div', { className: 'export-result' },
    el('div', { className: 'export-result-meta' },
      el('div', { className: 'export-result-title' }, `已导出${info.label || '文件'}：${info.filename}${sizeKb}`),
      el('div', { className: 'export-result-path mono' }, `保存路径：${info.filePath}`)),
    el('button', {
      type: 'button',
      className: 'btn sm',
      onClick: () => actions.openPath('exported_file', info.filename),
    }, '打开所在目录'))
}

const MAX_PERSONA_CHARS = 4000
const MAX_LIKE_TAGS = 6
const MAX_DISLIKE_TAGS = 12
const MAX_SAFETY_WORDS = 50
const LIKE_SUGGESTIONS = ['AI 工具', '科技新闻', '编程开发', '效率软件', '数码评测', '科普', '猫咪', '纪录片', '独立游戏', '影视解说']
const DISLIKE_SUGGESTIONS = ['带货', '擦边', '标题党', '纯搬运', '营销号', '引战', '剧透']

export function tagEditorCtrl({
  items,
  max,
  kind,
  draftValue,
  onDraftChange,
  onChange,
  suggestions = [],
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
    className: 'input tag-input',
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
        ? el('span', { className: 'row-hint' }, '暂未添加，可在下方输入后按回车添加。')
        : list.map(tag => el('span', { className: `tag-chip ${kind}` },
            tag,
            el('button', {
              type: 'button',
              className: 'tag-chip-rm',
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
      metaPill(`已选 ${list.length} / ${max}`, atMax ? 'warn' : '')),
    suggestions.length > 0
      ? el('div', { className: 'tag-suggest' },
          el('span', { className: 'tag-suggest-label' }, '快捷添加：'),
          ...suggestions.map(sug => {
            const exists = list.includes(sug)
            return el('button', {
              type: 'button',
              className: 'tag-suggest-btn',
              disabled: exists || atMax,
              onClick: () => addTags(sug),
            }, exists ? `${sug}（已添加）` : `+ ${sug}`)
          }))
      : null)
}

/**
 * Tab 1：账号与主人
 * - 含扫码登录、安全登出（清除登录凭据并暂停后台轮询防风控）、以及主人 UID 与昵称核验。
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
    cancelled: '已取消，原登录状态未改变。',
    success: qr?.account ? `已登录：${qr.account.name}（UID ${qr.account.mid}）。` : '登录成功。',
  }[qr?.status]

  const whaleCard = el('div', { className: 'card' },
    el('div', { className: 'card-head' },
      el('h2', {}, '大鲸鱼账号'),
      loggedIn ? statusPill('ok', '已连接账号') : statusPill('warn', '尚未登录')),
    el('p', { className: 'card-sub' }, '建议为大鲸鱼使用独立的 B 站账号。登录凭据保存在独立数据目录，仅当前 Windows 用户可读；退出登录将清除本地凭据并复核 B 站远程会话注销状态。'),
    el('div', { className: 'account-hero' },
      el('div', { className: 'account-meta' },
        el('div', { className: 'account-name-row' },
          el('span', { className: 'account-name' }, loggedIn ? (cfg.self.name || '已登录 B 站账号') : '尚未连接大鲸鱼 B 站账号'),
          loggedIn ? metaPill(`UID ${cfg.self.mid}`, 'mono') : null),
        el('div', { className: 'row-hint' }, loggedIn
          ? '可重新扫码刷新登录凭据，或退出登录以停止账号相关后台活动。'
          : '点击右侧「扫码登录」，使用手机哔哩哔哩 App 扫描二维码，校验通过后自动写入账号信息。'),
        qrLabel ? (qr?.status === 'success' ? banner('ok', qrLabel, { variant: 'inline-msg' }) : el('div', { className: 'row-hint hint-mt' }, qrLabel)) : null,
        qr?.account?.warn ? banner('warn', qr.account.warn) : null,
        state.logoutMsg ? banner(state.logoutMsg.kind || 'ok', state.logoutMsg.text, { variant: 'inline-msg' }) : null,
        state.qrError || qr?.error ? banner('err', state.qrError || qr.error, { variant: 'inline-msg' }) : null),
      el('div', { className: 'qr-wrap' },
        qr?.image ? el('img', { className: 'qr-img', src: qr.image, alt: 'B 站登录二维码' }) : null,
        el('div', { className: 'inline' },
          el('button', { type: 'button', className: 'btn primary', disabled: !!state.busy || qrActive, onClick: actions.qrStart },
            qr ? '重新生成二维码' : (loggedIn ? '重新扫码' : '扫码登录')),
          qrActive ? el('button', { type: 'button', className: 'btn', onClick: actions.qrCancel }, '取消登录') : null,
          loggedIn && !qrActive && !state.confirmLogout
            ? el('button', { type: 'button', className: 'btn danger', disabled: !!state.busy, onClick: () => { state.confirmLogout = true; actions.rerender() } }, '退出登录')
            : null,
          loggedIn && state.confirmLogout
            ? el('div', { className: 'inline' },
                el('button', { type: 'button', className: 'btn danger sm', disabled: !!state.busy, onClick: actions.logout }, state.busy === 'logout' ? '退出中…' : '确认退出登录'),
                el('button', { type: 'button', className: 'btn sm', disabled: !!state.busy, onClick: () => { state.confirmLogout = false; actions.rerender() } }, '取消'))
            : null))),
    row('大鲸鱼 UID', '只读；扫码登录后自动写入，退出登录后自动清空。', textCtrl(getPath(cfg, ['self', 'mid']), () => {}, { readOnly: true, placeholder: '扫码后自动获取' })),
    row('大鲸鱼昵称', '只读；来自 B 站账号信息接口，扫码登录后自动同步。', textCtrl(getPath(cfg, ['self', 'name']), () => {}, { readOnly: true, placeholder: '扫码后自动获取' })))

  const oc = state.ownerCheck
  const verifyButton = el('button', {
    type: 'button', className: 'btn', onClick: actions.verifyOwner,
    disabled: !!state.busy || !String(cfg.owner?.mid ?? '').trim(),
  }, state.busy === 'verify_owner' ? '核验中…' : '核验主人信息')
  const ownerCard = el('div', { className: 'card' },
    el('div', { className: 'card-head' },
      el('h2', {}, '主人账号'),
      verifyButton),
    el('p', { className: 'card-sub' }, '填写主人的 B 站 UID 与昵称，大鲸鱼据此识别主人身份、定向发送私信与评论区 @ 分享。填写 UID 后可点击右上角「核验主人信息」核对 B 站实际账号。'),
    row('主人 UID', '主人的 B 站个人空间数字 ID（即 mid），用于识别主人身份、评论回复与点赞互动。', textCtrl(getPath(cfg, ['owner', 'mid']), v => {
      state.ownerCheck = null
      state.ownerCheckErr = ''
      actions.setCfg(['owner', 'mid'], v)
      verifyButton.disabled = !!state.busy || !v.trim()
    }, { placeholder: '例如 12345678' })),
    row('主人昵称', '评论区 @ 分享或互动提及主人时使用；可仅填写 UID 后点击「核验主人信息」自动填入。', textCtrl(getPath(cfg, ['owner', 'name']), v => {
      state.ownerCheck = null
      state.ownerCheckErr = ''
      actions.setCfg(['owner', 'name'], v)
    }, { placeholder: '输入主人 B 站昵称' })),
    state.ownerCheckErr
      ? banner('err', state.ownerCheckErr, { variant: 'compact' })
      : null,
    oc
      ? banner(
          oc.matched === false ? 'warn' : 'ok',
          oc.detail + (oc.sign ? `\n签名：${oc.sign}` : ''),
          {
            variant: 'compact',
            action: oc.matched !== true && oc.actualName
              ? el('button', {
                  type: 'button',
                  className: 'btn primary sm',
                  onClick: () => actions.applyOwnerName(oc.actualName),
                }, oc.matched === false ? `同步为「${oc.actualName}」` : `一键填入「${oc.actualName}」`)
              : null,
          },
        )
      : null)

  return el('div', {}, whaleCard, ownerCard)
}

/**
 * Tab 2：人设与作息
 */
export function renderPersonaTab(state, actions) {
  const cfg = state.cfg
  const personaLen = state.personaText.length
  const personaOver = personaLen > MAX_PERSONA_CHARS

  const namingCard = el('div', { className: 'card' },
    el('h2', {}, '基础称呼'),
    el('p', { className: 'card-sub' }, '配置大鲸鱼的角色名称、对主人的称呼与自称方式；修改后请点击右上角「保存配置」生效。'),
    row('角色名称', '大鲸鱼被提及或自我介绍时使用的名称，默认「大鲸鱼」。', textCtrl(getPath(cfg, ['persona', 'name']) || '大鲸鱼', v => actions.setCfg(['persona', 'name'], v), { placeholder: '大鲸鱼' })),
    row('对主人的称呼', '大鲸鱼与主人互动时使用的称呼，例如「主人」或专属昵称。', textCtrl(getPath(cfg, ['persona', 'ownerTitle']), v => actions.setCfg(['persona', 'ownerTitle'], v))),
    row('角色自称', '大鲸鱼在对话与评论中使用的第一人称自称，例如「我」。', textCtrl(getPath(cfg, ['persona', 'selfClaim']), v => actions.setCfg(['persona', 'selfClaim'], v))))

  const personaCard = el('div', { className: 'card' },
    el('h2', {}, '人设正文'),
    el('p', { className: 'card-sub' }, `仅对大鲸鱼的 B 站互动生效，不影响日常编程对话。保存路径：${state.personaPath || '%USERPROFILE%\\.antigravity-bili-whale\\persona.md'}。建议控制在 300–1500 字以获得最佳遵循效果，硬上限 ${MAX_PERSONA_CHARS} 字。`),
    el('textarea', {
      className: 'textarea',
      rows: 9,
      maxLength: MAX_PERSONA_CHARS,
      placeholder: '例如：\n性格特点与表达风格（简洁自然、真诚随和…）\n兴趣背景与日常习惯…\n关注的话题方向…\n互动原则与行为边界…',
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
    el('div', { className: 'inline-between mt-10' },
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
      }, state.busy === 'persona' ? '保存中…' : '保存人设')),
    state.personaMsg ? banner(state.personaMsg.kind || 'ok', state.personaMsg.text, { variant: 'compact' }) : null)

  const tasteCard = el('div', { className: 'card' },
    el('h2', {}, '口味偏好'),
    el('p', { className: 'card-sub' }, '配置自主浏览时的优先检索主题与屏蔽主题；修改后请点击右上角「保存配置」生效。'),
    row(
      '喜欢的主题标签',
      '每次唤醒按已选主题检索候选视频并提高权重，最多 6 个以避免触发 B 站限流。',
      tagEditorCtrl({
        items: getPath(cfg, ['preferences', 'like']),
        max: MAX_LIKE_TAGS,
        kind: 'like',
        draftValue: state.likeTagDraft,
        onDraftChange: (v) => { state.likeTagDraft = v },
        onChange: (next) => actions.setCfg(['preferences', 'like'], next, true),
        suggestions: LIKE_SUGGESTIONS,
        placeholder: '输入喜欢的主题后按回车，如 AI 工具',
      })),
    row(
      '屏蔽的主题标签',
      '视频标题或标签命中时自动降权或排除，最多 12 个。',
      tagEditorCtrl({
        items: getPath(cfg, ['preferences', 'dislike']),
        max: MAX_DISLIKE_TAGS,
        kind: 'dislike',
        draftValue: state.dislikeTagDraft,
        onDraftChange: (v) => { state.dislikeTagDraft = v },
        onChange: (next) => actions.setCfg(['preferences', 'dislike'], next, true),
        suggestions: DISLIKE_SUGGESTIONS,
        placeholder: '输入需屏蔽的主题后按回车，如 带货',
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

  const plan = state.status?.plan
  const planBadge = plan?.action === 'wake' && plan?.atText
    ? metaPill(`当前计划：${plan.atText}（今日已用 ${plan.wakes ?? 0} 次机会）`, 'info')
    : (plan ? metaPill(`今日已用 ${plan.wakes ?? 0} 次机会`) : null)

  const nightCard = el('div', { className: 'card' },
    el('div', { className: 'card-head' },
      el('div', { className: 'inline' },
        el('h2', {}, '作息与唤醒'),
        planBadge),
      el('button', {
        type: 'button',
        className: 'btn primary',
        disabled: !!state.busy,
        onClick: actions.wakeNow,
      }, state.busy === 'wake_now' ? '唤醒中…' : '立即唤醒')),
    el('p', { className: 'card-sub' }, '在每个时间窗内按剩余次数分段随机触发定时唤醒（避开整点集中请求），时间格式为 HH:MM（00:00–24:00），全天合计最多 12 次。点击右上角「立即唤醒」可不受排期限制立即执行一轮。'),
    state.wakeMsg ? banner(state.wakeMsg.kind, state.wakeMsg.text) : null,
    wins.length === 0
      ? el('div', { className: 'row-hint' }, '尚未配置时间窗，请至少添加一个。')
      : el('div', {}, ...wins.map((w, i) =>
          el('div', { className: 'row' },
            el('div', { className: 'inline' },
              el('span', { className: 'row-hint win-idx' }, nums[i] ?? String(i + 1)),
              el('input', { className: 'input sm', value: w.start ?? '', placeholder: '20:00', onChange: e => updWin(i, { start: e.target.value }) }),
              el('span', { className: 'row-hint' }, '–'),
              el('input', { className: 'input sm', value: w.end ?? '', placeholder: '24:00', onChange: e => updWin(i, { end: e.target.value }) }),
              el('span', { className: 'row-hint' }, '唤醒'),
              el('input', { className: 'input xs', type: 'number', min: 1, max: 12, value: w.wakes ?? 1, onChange: e => updWin(i, { wakes: Math.min(12, Math.max(1, Number(e.target.value) || 1)) }) }),
              el('span', { className: 'row-hint' }, '次')),
            el('button', { type: 'button', className: 'btn danger sm', disabled: wins.length <= 1, onClick: () => delWin(i) }, '删除')))),
    totalConfiguredWakes > 12
      ? banner('warn', `当前所有时间窗的唤醒次数合计 ${totalConfiguredWakes} 次，超过每日上限 12 次；实际每天最多执行 12 次。`, { variant: 'top-gap' })
      : null,
    el('div', { className: 'inline action-row' },
      el('button', { type: 'button', className: 'btn', onClick: addWin }, '+ 添加时间窗')),
    row(
      '最小唤醒间隔',
      '两次唤醒之间的硬性下限，默认 10 分钟；窗口内排不下的次数自动放弃，另含每轮结束后 8 分钟冷却。',
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
      '单次跳过概率',
      '0% 表示每次唤醒均观看视频；最高 80% 表示多数情况下跳过观看。跳过仅消耗本次唤醒机会。',
      selectCtrl(
        String(snappedSkip),
        [
          ['0', '0%（每次必看，从不跳过）'],
          ['0.2', '20%（偶尔跳过，推荐）'],
          ['0.4', '40%（有时跳过）'],
          ['0.6', '60%（多数时候跳过）'],
          ['0.8', '80%（极少观看，最高档）'],
        ],
        v => actions.setCfg(['night', 'skipChance'], Number(v), true),
      )),
    row(
      '单次候选视频数',
      '每次唤醒初筛最多获取的候选视频数量，范围 1–10 条。',
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
      '单次深度观看数',
      '从候选视频中挑选最感兴趣内容进行完整字幕、弹幕、评论与画面分析的数量上限，范围 1–3 条且不超过候选数。',
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

function pollIntervalOptions(cur) {
  const base = [
    ['30', '每 30 秒检查一次（响应较快）'],
    ['60', '每 60 秒检查一次'],
    ['120', '每 120 秒（2 分钟）检查一次'],
    ['300', '每 300 秒（5 分钟）检查一次（默认）'],
  ]
  const s = String(cur ?? 300)
  if (!base.some(([v]) => v === s)) base.unshift([s, `每 ${s} 秒检查一次（当前）`])
  return base
}

/**
 * Tab 5：互动与安全（五大模块；模块 1–4 对外互动开关默认关闭，自主评论默认开启，模块 5 合规安全审核默认开启）
 */
export function renderInteractTab(state, actions) {
  const cfg = state.cfg
  const browseEnabled = getPath(cfg, ['browse', 'enabled']) === true
  const autoCommentEnabled = getPath(cfg, ['chat', 'autoComment']) !== false
  const autoCommentDailyMax = Math.min(10, Math.max(1, Number(getPath(cfg, ['chat', 'autoCommentDailyMax']) ?? 3) || 3))
  const dynamicEnabled = getPath(cfg, ['chat', 'dynamic']) === true
  const dynamicDailyMax = Math.min(2, Math.max(1, Number(getPath(cfg, ['chat', 'dynamicDailyMax']) ?? 1) || 1))
  const shareEnabled = getPath(cfg, ['share', 'enabled']) === true
  const dmOwner = getPath(cfg, ['listen', 'dmOwner']) === true
  const dmFan = getPath(cfg, ['listen', 'dmFan']) === true
  const dmIntervalSec = Number(getPath(cfg, ['listen', 'dmIntervalSec']) ?? 300)
  const commentOwner = getPath(cfg, ['listen', 'commentOwner']) === true
  const commentFan = getPath(cfg, ['listen', 'commentFan']) === true
  const commentIntervalSec = Number(getPath(cfg, ['listen', 'commentIntervalSec']) ?? 300)
  const safetyEnabled = getPath(cfg, ['safety', 'enabled']) !== false
  const limits = getPath(cfg, ['fanLimits']) ?? {}

  const autoCommentMaxOpts = [
    ['1', '每天最多 1 条'],
    ['2', '每天最多 2 条'],
    ['3', '每天最多 3 条（默认）'],
    ['5', '每天最多 5 条'],
  ]
  if (!autoCommentMaxOpts.some(([v]) => v === String(autoCommentDailyMax))) {
    autoCommentMaxOpts.unshift([String(autoCommentDailyMax), `每天最多 ${autoCommentDailyMax} 条（当前）`])
  }

  const mod1Card = el('div', { className: 'card' },
    el('h2', {}, '一、自主观看、评论与动态'),
    el('p', { className: 'card-sub' }, '控制是否按「人设与作息」的时间窗自主观看视频，以及观看后是否允许自主发表评论或发布公开动态。'),
    row('允许按作息自主观看视频', '开启后按「人设与作息」的时间窗自动唤醒并浏览观看视频；关闭时仅响应已开启的被动回复，默认关闭。',
      switchCtrl('允许按作息自主观看视频', browseEnabled, v => actions.setCfg(['browse', 'enabled'], v, true))),
    row('允许观看后自主发表评论', '观看视频后确有观点时可在评论区发表普通评论，不 @ 主人；须通过外发安全审核，同一视频 7 天内不重复评论，默认开启。',
      switchCtrl('允许观看后自主发表评论', autoCommentEnabled, v => actions.setCfg(['chat', 'autoComment'], v, true))),
    autoCommentEnabled
      ? el('div', { className: 'sub-block' },
          row('每日自主评论上限', '限制大鲸鱼每天自主发表普通视频评论的上限，防止刷屏或触发 B 站风控。',
            selectCtrl(String(autoCommentDailyMax), autoCommentMaxOpts, v => actions.setCfg(['chat', 'autoCommentDailyMax'], Number(v), true))))
      : null,
    row('允许观看后发布公开动态', '本轮观看视频且确有公开感想时允许发布公开动态；须通过外发安全审核，默认关闭。',
      switchCtrl('允许观看后发布公开动态', dynamicEnabled, v => actions.setCfg(['chat', 'dynamic'], v, true))),
    dynamicEnabled
      ? el('div', { className: 'sub-block' },
          row('每日公开动态上限', '限制大鲸鱼每天自主发布公开动态的上限，最多 2 条，防止刷屏或触发 B 站风控。',
            selectCtrl(String(dynamicDailyMax), [
              ['1', '每天最多 1 条（默认）'],
              ['2', '每天最多 2 条（上限）'],
            ], v => actions.setCfg(['chat', 'dynamicDailyMax'], Number(v), true))))
      : null)

  const mod2Card = el('div', { className: 'card' },
    el('h2', {}, '二、主动分享给主人'),
    el('p', { className: 'card-sub' }, '大鲸鱼发现值得推荐的视频时仅主动分享给主人，绝不向其他用户主动推荐。'),
    row('允许主动分享给主人', '开启后可在下方选择通过评论区 @ 或私信向主人推荐视频，默认关闭。',
      switchCtrl('允许主动分享给主人', shareEnabled, v => actions.setCfg(['share', 'enabled'], v, true))),
    shareEnabled
      ? el('div', { className: 'sub-block' },
          row('分享方式', '私信需与主人互关；评论区会在对应视频下方 @ 主人。',
            selectCtrl(getPath(cfg, ['share', 'via']) ?? 'comment', [
              ['dm', 'B 站私信（需互关）'],
              ['comment', '视频评论区 @ 主人（默认）'],
            ], v => actions.setCfg(['share', 'via'], v, true))),
          row('每日分享上限', '建议不超过 3 条，避免触发 B 站限流或风控。',
            selectCtrl(String(getPath(cfg, ['quota', 'shareDaily']) ?? 3), [
              ['1', '每天最多 1 条'],
              ['2', '每天最多 2 条'],
              ['3', '每天最多 3 条（默认）'],
              ['5', '每天最多 5 条'],
            ], v => actions.setCfg(['quota', 'shareDaily'], Number(v), true))))
      : null)

  const mod3Card = el('div', { className: 'card' },
    el('h2', {}, '三、私信被动回复'),
    el('p', { className: 'card-sub' }, '仅被动回复收到的私信；除「二、主动分享给主人」外，代码层禁止向任何用户主动发起私信，无新私信时零模型消耗。'),
    row('回复主人私信', '定时检查主人发给大鲸鱼的私信并自然回复，不限条数，默认关闭。',
      switchCtrl('回复主人私信', dmOwner, v => actions.setCfg(['listen', 'dmOwner'], v, true))),
    dmOwner
      ? el('div', { className: 'sub-block' },
          row('允许对话后补充后续私信', '回复主人后的数分钟内，若有未说完的实质内容可补充发送一条私信，默认关闭。',
            switchCtrl('允许对话后补充后续私信', getPath(cfg, ['chat', 'followup']) === true, v => actions.setCfg(['chat', 'followup'], v, true))))
      : null,
    row('回复已关注粉丝私信', '收到已关注粉丝私信后自动回复，未关注用户一律忽略；所有回复均须通过下方安全审核，默认关闭。',
      switchCtrl('回复已关注粉丝私信', dmFan, v => actions.setCfg(['listen', 'dmFan'], v, true))),
    dmFan
      ? el('div', { className: 'sub-block' },
          row('单粉丝每日私信回复上限', '限制单个粉丝每日最多收到的私信回复条数，防止刷屏或触发风控。',
            selectCtrl(String(limits.dmPerUserDaily ?? 2), [
              ['1', '每人每天最多 1 条'],
              ['2', '每人每天最多 2 条（默认）'],
              ['3', '每人每天最多 3 条'],
              ['5', '每人每天最多 5 条'],
            ], v => actions.setCfg(['fanLimits', 'dmPerUserDaily'], Number(v), true))),
          row('全天粉丝私信回复总上限', '全天回复所有粉丝私信的总条数上限。',
            selectCtrl(String(limits.dmTotalDaily ?? 10), [
              ['5', '每天总计最多 5 条'],
              ['10', '每天总计最多 10 条（默认）'],
              ['20', '每天总计最多 20 条'],
              ['30', '每天总计最多 30 条'],
            ], v => actions.setCfg(['fanLimits', 'dmTotalDaily'], Number(v), true))))
      : null,
    (dmOwner || dmFan)
      ? row('私信轮询间隔', '后台守护检查新私信的时间间隔；无新私信时零模型消耗，默认每 300 秒（5 分钟）检查一次。',
          selectCtrl(String(dmIntervalSec), pollIntervalOptions(dmIntervalSec), v => actions.setCfg(['listen', 'dmIntervalSec'], Number(v), true)))
      : null)

  const mod4Card = el('div', { className: 'card' },
    el('h2', {}, '四、评论区被动回复'),
    el('p', { className: 'card-sub' }, '仅被动回复评论区收到的回复与 @；开启对应开关后可按「视频观看」的时长与抽帧规则观看并回复，所有回复经安全审核通过后发出。'),
    row('回复主人评论与 @', '自动回复主人在评论区对大鲸鱼的评论与 @，默认关闭。',
      switchCtrl('回复主人评论与 @', commentOwner, v => actions.setCfg(['listen', 'commentOwner'], v, true))),
    commentOwner
      ? el('div', { className: 'sub-block' },
          row('允许主人 @ 时自主判断是否观看视频', '开启后，主人在评论区 @ 大鲸鱼时，大鲸鱼将根据提问自主判断是否需要先观看视频再回复；需要观看时按「视频观看 → 二、主人评论区 @ 观看与总结」执行，默认关闭。',
            el('div', { className: 'inline' },
              switchCtrl('允许主人 @ 时自主判断是否观看视频', getPath(cfg, ['listen', 'mentionSummaryOwner']) === true, v => actions.setCfg(['listen', 'mentionSummaryOwner'], v, true)),
              el('button', { type: 'button', className: 'btn sm', onClick: () => actions.switchTab('watch') }, '设置观看规则'))))
      : null,
    row('回复已关注粉丝评论与 @', '实时校验对方是否已关注大鲸鱼，未关注用户评论一律忽略；经安全审核通过后回复，默认关闭。',
      switchCtrl('回复已关注粉丝评论与 @', commentFan, v => actions.setCfg(['listen', 'commentFan'], v, true))),
    commentFan
      ? el('div', { className: 'sub-block' },
          row('允许响应粉丝评论区 @ 总结', '已关注粉丝在视频评论区 @ 大鲸鱼请求总结时，按「视频观看 → 三、粉丝评论区 @ 观看与总结」执行，默认关闭。',
            el('div', { className: 'inline' },
              switchCtrl('允许响应粉丝评论区 @ 总结', getPath(cfg, ['listen', 'mentionSummaryFan']) === true, v => actions.setCfg(['listen', 'mentionSummaryFan'], v, true)),
              el('button', { type: 'button', className: 'btn sm', onClick: () => actions.switchTab('watch') }, '设置粉丝规则'))),
          row('单粉丝每日评论回复上限', '限制单个粉丝每日可获评论回复的上限，防止刷楼与风控。',
            selectCtrl(String(limits.commentPerUserDaily ?? 1), [
              ['1', '每人每天最多 1 条（默认）'],
              ['2', '每人每天最多 2 条'],
              ['3', '每人每天最多 3 条'],
              ['5', '每人每天最多 5 条'],
            ], v => actions.setCfg(['fanLimits', 'commentPerUserDaily'], Number(v), true))),
          row('全天粉丝评论回复总上限', '全天回复所有粉丝评论的总条数上限。',
            selectCtrl(String(limits.commentTotalDaily ?? 10), [
              ['5', '每天总计最多 5 条'],
              ['10', '每天总计最多 10 条（默认）'],
              ['20', '每天总计最多 20 条'],
              ['30', '每天总计最多 30 条'],
            ], v => actions.setCfg(['fanLimits', 'commentTotalDaily'], Number(v), true))))
      : null,
    (commentOwner || commentFan)
      ? row('评论与 @ 轮询间隔', '后台守护检查「回复我的」与「@ 我的」收件箱的时间间隔；无新消息时零模型消耗。',
          selectCtrl(String(commentIntervalSec), pollIntervalOptions(commentIntervalSec), v => actions.setCfg(['listen', 'commentIntervalSec'], Number(v), true)))
      : null,
    (commentOwner || commentFan)
      ? row('作息时间窗外持续监听评论', '关闭时仅在「人设与作息」配置的时间窗内轮询评论收件箱，默认关闭。',
          switchCtrl('作息时间窗外持续监听评论', getPath(cfg, ['listen', 'allDay']) === true, v => actions.setCfg(['listen', 'allDay'], v, true)))
      : null)

  const mod5Card = el('div', { className: 'card' },
    el('div', { className: 'card-head' },
      el('h2', {}, '五、外发内容安全审核'),
      statusPill(safetyEnabled ? 'ok' : 'err', safetyEnabled ? '安全保护已开启' : '安全保护已关闭')),
    el('p', { className: 'card-sub' }, '合规红线默认开启，所有外发评论、动态与私信在发送前自动检查：严禁发送违反中国法律法规、涉政敏感、暴力低俗、赌博诈骗、人肉隐私或恶意引战内容，命中即直接拦截。'),
    row('开启外发内容安全审核', '强烈建议保持开启；默认开启作为合规底线，代码层强制执行拦截。',
      switchCtrl('开启外发内容安全审核', safetyEnabled, v => actions.setCfg(['safety', 'enabled'], v, true))),
    safetyEnabled
      ? el('div', { className: 'sub-block' },
          row('安全审核方式', '「双重审核」同时使用本地红线规则与 Antigravity 后台辅助模型语义复审，可识别谐音、隐喻与钓鱼诱导。',
            selectCtrl(getPath(cfg, ['safety', 'mode']) ?? 'dual', [
              ['dual', '本地红线规则 + 内置模型语义复审（推荐）'],
              ['local_only', '仅本地红线规则与敏感词库（零模型消耗）'],
            ], v => actions.setCfg(['safety', 'mode'], v, true))),
          row('审核覆盖范围', '建议覆盖全部外发内容，也可仅对公开评论、动态与粉丝私信启用。',
            selectCtrl(getPath(cfg, ['safety', 'scope']) ?? 'all', [
              ['all', '全部外发内容（评论、动态、所有私信）'],
              ['external_only', '仅对外内容（公开评论、动态、粉丝私信）'],
            ], v => actions.setCfg(['safety', 'scope'], v, true))),
          row('自定义屏蔽词', '除内置法律法规红线外，可自行补充禁止大鲸鱼提及的词汇，最多 50 个。',
            tagEditorCtrl({
              items: getPath(cfg, ['safety', 'customWords']),
              max: MAX_SAFETY_WORDS,
              kind: 'dislike',
              draftValue: state.safetyWordDraft,
              onDraftChange: (v) => { state.safetyWordDraft = v },
              onChange: (next) => actions.setCfg(['safety', 'customWords'], next, true),
              placeholder: '输入需拦截的词后按回车',
            })))
      : null)

  return el('div', {}, mod1Card, mod2Card, mod3Card, mod4Card, mod5Card)
}

function renderEnvRow(card, state, actions) {
  const statusMap = {
    ok: { cls: 'ok', label: '正常' },
    optional: { cls: 'warn', label: '可选未装' },
    error: { cls: 'err', label: '需处理' },
  }
  const st = statusMap[card.status] || statusMap.error
  const showPath = (card.key === 'node' || card.key === 'ffmpeg') && Boolean(card.location)
  const detailText = card.fix && card.fix !== card.detail
    ? `${card.detail ? card.detail + ' · ' : ''}${card.fix}`
    : (card.detail || '')
  const hintText = showPath ? `路径：${card.location}` : (detailText || '运行正常。')
  const verText = card.version || '-'

  return el('div', { className: 'env-row' },
    el('div', { className: 'env-row-main' },
      el('div', { className: 'env-row-title' }, card.name),
      el('div', { className: showPath ? 'env-row-hint mono' : 'env-row-hint' }, hintText)),
    el('div', { className: 'env-row-right' },
      el('span', { className: 'env-ver-chip mono' }, verText),
      card.action === 'goto_login'
        ? el('button', {
            type: 'button',
            className: 'btn primary sm',
            disabled: !!state.busy,
            onClick: () => actions.switchTab('account'),
          }, '前往登录')
        : null,
      statusPill(st.cls, st.label)))
}

/**
 * Tab 7：环境与依赖（完整路径逐行展示 + 带时间戳脱敏诊断日志本地导出）
 */
export function renderEnvTab(state, actions) {
  const deps = state.depsData
  const cards = deps?.cards ?? []
  const errorCount = cards.filter(c => c.status === 'error').length
  const optionalCount = cards.filter(c => c.status === 'optional').length
  const summaryPill = !deps
    ? metaPill(state.busy === 'deps' ? '检测中…' : '等待检测')
    : errorCount === 0
      ? statusPill('ok', optionalCount > 0 ? `核心环境已就绪（${optionalCount} 项可选）` : '全部环境与依赖正常')
      : statusPill('err', `${errorCount} 项需要处理`)

  return el('div', { className: 'card' },
    el('div', { className: 'card-head' },
      el('div', { className: 'inline' },
        el('h2', {}, '运行环境与依赖'),
        summaryPill),
      el('div', { className: 'inline' },
        el('button', { type: 'button', className: 'btn primary', disabled: !!state.busy, onClick: actions.runDeps }, state.busy === 'deps' ? '检测中…' : '重新检测'),
        el('button', { type: 'button', className: 'btn', disabled: !!state.busy, onClick: actions.exportDiagnostics }, state.busy === 'export_diag' ? '导出中…' : '导出诊断日志'))),
    el('p', { className: 'card-sub' }, '逐行展示后台守护（Sidecar）、Node.js、ffmpeg、B 站登录状态及接口保护状态。排查问题时可点击「导出诊断日志」生成带时间戳的脱敏文件。'),
    renderExportResult(state.diagExport, actions),
    state.diagErr ? banner('err', state.diagErr) : null,
    cards.length > 0
      ? el('div', { className: 'env-list' }, ...cards.map(c => renderEnvRow(c, state, actions)))
      : el('div', { className: 'row-hint empty-hint' }, state.busy === 'deps' ? '正在逐项检测运行环境与依赖版本…' : '点击「重新检测」查看各项环境模块状态。'))
}
