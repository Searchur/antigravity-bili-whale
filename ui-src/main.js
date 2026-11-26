import { createMcpBridge } from './bridge.js'
import {
  el,
  setPath,
  renderAccountTab,
  renderPersonaTab,
  renderInteractTab,
  renderEnvTab,
} from './render-sections.js'
import { renderModelsTab } from './render-models.js'
import { renderWatchTab } from './render-watch.js'
import { renderMemoryTab } from './render-memory.js'
import { renderAboutTab } from './render-about.js'

const state = {
  ready: false,
  tab: 'account',
  busy: '',
  banner: null,
  cfg: null,
  savedJson: '',
  personaText: '',
  personaBytes: 0,
  personaPath: '',
  personaMsg: '',
  likeTagDraft: '',
  dislikeTagDraft: '',
  safetyWordDraft: '',
  ownerCheck: null,
  ownerCheckErr: '',
  confirmLogout: false,
  logoutMsg: '',
  qr: null,
  qrError: '',
  modelCatalog: null,
  modelRole: 'main',
  modelsError: '',
  status: null,
  depsData: null,
  depsLoaded: false,
  depsError: '',
  ffmpegMsg: null,
  diagMsg: null,
  about: null,
  updateCheck: null,
  updateResult: null,
  updateError: '',
  copiedKey: '',
  lifeState: null,
  lifeLoaded: false,
  lifeQuery: '',
  lifeNote: '',
  lifeReceipt: '',
  lifeVerified: false,
  lifeSearchItems: null,
  lifeMsg: '',
  lifeError: '',
}

const qrFlow = { gen: 0, id: null, timer: null }
const root = document.getElementById('root')

function mount(...nodes) {
  root.replaceChildren(...nodes.filter(Boolean))
}

function setBanner(kind, text) {
  state.banner = text ? { kind, text } : null
  render()
}

function downloadJson(filename, obj) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(obj, null, 2)], { type: 'application/json' }))
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

const bridge = createMcpBridge({
  onInitialResult: (payload) => {
    if (payload?.settings?.config && !state.cfg) {
      state.cfg = payload.settings.config
      state.savedJson = JSON.stringify(payload.settings.config)
      state.status = payload.status ?? state.status
      if (payload.models) state.modelCatalog = payload.models
      if (payload.about) state.about = payload.about
      state.ready = true
      render()
    }
  },
})

function cancelQrInternal() {
  qrFlow.gen++
  clearTimeout(qrFlow.timer)
  const id = qrFlow.id
  qrFlow.id = null
  if (id) void bridge.callTool('whale_app_auth', { action: 'qr_cancel', id }).catch(() => {})
}

function switchTab(id) {
  state.tab = id
  render()
  if (id === 'models' && state.modelCatalog?.source !== 'live') void actions.refreshModels()
  if (id === 'memory') {
    void actions.refreshStatus()
    if (!state.lifeLoaded) void actions.runLife('status')
  }
  if (id === 'env' && !state.depsLoaded) void actions.runDeps()
  if (id === 'about' && !state.about) void actions.refreshAbout()
}

const actions = {
  rerender: () => render(),
  switchTab,

  openUrl(url) {
    void bridge.openLink(url)
  },

  async copyText(text, key) {
    try {
      await navigator.clipboard.writeText(text)
    } catch {
      const ta = document.createElement('textarea')
      ta.value = text
      document.body.appendChild(ta)
      ta.select()
      try { document.execCommand('copy') } catch {}
      ta.remove()
    }
    state.copiedKey = key
    render()
    setTimeout(() => {
      if (state.copiedKey === key) {
        state.copiedKey = ''
        render()
      }
    }, 2000)
  },

  setCfg(pathArr, value, shouldRender = false) {
    if (!state.cfg) return
    setPath(state.cfg, pathArr, value)
    if (shouldRender) render()
    else updateSaveStatePill()
  },

  setModelRole(role) {
    state.modelRole = role === 'worker' ? 'worker' : 'main'
    render()
  },

  selectModel(role, modelId) {
    if (!state.cfg || !modelId) return
    setPath(state.cfg, ['models', role === 'worker' ? 'worker' : 'main'], modelId)
    render()
  },

  async logout() {
    cancelQrInternal()
    state.busy = 'logout'
    state.logoutMsg = ''
    render()
    try {
      const res = await bridge.callTool('whale_app_auth', { action: 'logout' })
      state.confirmLogout = false
      state.qr = null
      state.qrError = ''
      if (state.cfg) {
        state.cfg.self = { mid: '', name: '' }
        state.savedJson = JSON.stringify(state.cfg)
      }
      state.depsLoaded = false
      state.logoutMsg = res.detail || '✓ 已退出登录并清除本地凭据'
    } catch (e) {
      state.logoutMsg = '✗ 退出登录失败：' + e.message
    } finally {
      state.busy = ''
      render()
    }
  },

  async verifyOwner() {
    const mid = String(state.cfg?.owner?.mid ?? '').trim()
    const name = String(state.cfg?.owner?.name ?? '').trim()
    state.busy = 'verify_owner'
    state.ownerCheck = null
    state.ownerCheckErr = ''
    render()
    try {
      state.ownerCheck = await bridge.callTool('whale_app_ops', { action: 'verify_owner', mid, name })
    } catch (e) {
      state.ownerCheckErr = e.message
    } finally {
      state.busy = ''
      render()
    }
  },

  applyOwnerName(actualName) {
    if (!state.cfg || !actualName) return
    setPath(state.cfg, ['owner', 'name'], actualName)
    if (state.ownerCheck) {
      state.ownerCheck = {
        ...state.ownerCheck,
        matched: true,
        expectedName: actualName,
        detail: `✓ 已同步为 B 站实际昵称「${actualName}」（记得点击右上角「保存配置」）`,
      }
    }
    render()
  },

  async bootstrap() {
    state.busy = 'load'
    render()
    try {
      const res = await bridge.callTool('whale_app_bootstrap')
      state.cfg = res.settings?.config ?? {}
      state.savedJson = JSON.stringify(state.cfg)
      state.personaText = res.persona?.text ?? ''
      state.personaBytes = res.persona?.bytes ?? 0
      state.personaPath = res.persona?.path ?? ''
      state.status = res.status ?? null
      if (res.models) state.modelCatalog = res.models
      if (res.about) state.about = res.about
      state.ownerCheck = null
      state.ownerCheckErr = ''
      state.confirmLogout = false
      state.ready = true
      state.banner = null
    } catch (e) {
      setBanner('err', '加载配置失败：' + e.message)
    } finally {
      state.busy = ''
      render()
    }
  },

  async refreshAbout() {
    try {
      state.about = await bridge.callTool('whale_app_ops', { action: 'about' })
      render()
    } catch {}
  },

  async checkUpdate() {
    state.busy = 'update_check'
    state.updateError = ''
    render()
    try {
      const res = await bridge.callTool('whale_app_ops', { action: 'update_check' })
      state.updateCheck = res
      if (res.local) state.about = { ok: true, local: res.local }
    } catch (e) {
      state.updateError = '检查更新失败：' + e.message
    } finally {
      state.busy = ''
      render()
    }
  },

  async applyUpdate(ref = 'main') {
    state.busy = 'update_apply'
    state.updateError = ''
    state.updateResult = { kind: 'warn', text: '正在从 GitHub 下载最新版插件压缩包、校验完整性并更新本地文件（约 5–20 秒）…' }
    render()
    try {
      const res = await bridge.callTool('whale_app_ops', { action: 'update_apply', ref })
      state.updateResult = { kind: 'ok', text: `✓ ${res.message}` }
      await actions.refreshAbout()
    } catch (e) {
      state.updateResult = null
      state.updateError = '本地一键更新失败：' + e.message
    } finally {
      state.busy = ''
      render()
    }
  },

  async refreshModels() {
    state.busy = 'models'
    state.modelsError = ''
    render()
    try {
      state.modelCatalog = await bridge.callTool('whale_app_ops', { action: 'models' })
    } catch (e) {
      state.modelsError = '读取 Antigravity 模型列表失败：' + e.message
    } finally {
      state.busy = ''
      render()
    }
  },

  async saveSettings() {
    state.busy = 'save'
    state.banner = null
    render()
    try {
      const res = await bridge.callTool('whale_app_settings', { action: 'save', config: state.cfg })
      if (res.config) {
        state.cfg = res.config
        state.savedJson = JSON.stringify(res.config)
      }
      setBanner(res.warn ? 'warn' : 'ok', `✓ 配置已保存（${res.configPath || ''}）${res.warn ? '\n⚠ ' + res.warn : ''}`)
      return true
    } catch (e) {
      setBanner('err', '保存失败：' + e.message)
      return false
    } finally {
      state.busy = ''
      render()
    }
  },

  async savePersona() {
    state.busy = 'persona'
    state.personaMsg = ''
    render()
    try {
      const res = await bridge.callTool('whale_app_persona', { action: 'save', text: state.personaText })
      state.personaBytes = res.bytes ?? 0
      state.personaMsg = res.detail || '✓ 已保存'
    } catch (e) {
      state.personaMsg = '✗ ' + e.message
    } finally {
      state.busy = ''
      render()
    }
  },

  async qrStart() {
    cancelQrInternal()
    state.confirmLogout = false
    state.logoutMsg = ''
    state.qrError = ''
    state.qr = { status: 'starting' }
    const gen = qrFlow.gen
    render()
    try {
      const init = await bridge.callTool('whale_app_auth', { action: 'qr_start' })
      if (gen !== qrFlow.gen) {
        void bridge.callTool('whale_app_auth', { action: 'qr_cancel', id: init.id }).catch(() => {})
        return
      }
      qrFlow.id = init.id
      state.qr = init
      render()
      const poll = async () => {
        try {
          const r = await bridge.callTool('whale_app_auth', { action: 'qr_poll', id: init.id })
          if (gen !== qrFlow.gen) return
          state.qr = r
          if (r.status === 'success') {
            qrFlow.id = null
            if (r.account && state.cfg) {
              state.cfg.self = { mid: r.account.mid, name: r.account.name }
              state.savedJson = JSON.stringify(state.cfg)
            }
            state.depsLoaded = false
          } else if (['waiting', 'scanned'].includes(r.status)) {
            qrFlow.timer = setTimeout(poll, 2200)
          }
          render()
        } catch (e) {
          if (gen !== qrFlow.gen) return
          cancelQrInternal()
          state.qrError = e.message
          state.qr = { status: 'error' }
          render()
        }
      }
      qrFlow.timer = setTimeout(poll, 2200)
    } catch (e) {
      if (gen === qrFlow.gen) {
        state.qrError = e.message
        state.qr = { status: 'error' }
        render()
      }
    }
  },

  qrCancel() {
    cancelQrInternal()
    state.qr = { status: 'cancelled' }
    render()
  },

  async runDeps() {
    state.busy = 'deps'
    state.depsError = ''
    render()
    try {
      const j = await bridge.callTool('whale_app_ops', { action: 'deps' })
      state.depsData = j
      state.depsLoaded = true
      if (j.error) state.depsError = j.error
      if (j.self && state.cfg) {
        state.cfg.self = j.self
        state.savedJson = JSON.stringify(state.cfg)
      }
    } catch (e) {
      state.depsError = '环境检测失败：' + e.message
    } finally {
      state.busy = ''
      render()
    }
  },

  async exportDiagnostics() {
    state.busy = 'export_diag'
    state.diagMsg = null
    render()
    try {
      const res = await bridge.callTool('whale_app_ops', { action: 'export_diag' })
      downloadJson(res.filename || `antigravity-bili-whale-diag-${Date.now()}.json`, res.payload)
      state.diagMsg = { kind: 'ok', text: `✓ 已导出带时间戳的脱敏诊断日志：${res.filename}` }
    } catch (e) {
      state.diagMsg = { kind: 'err', text: '导出诊断日志失败：' + e.message }
    } finally {
      state.busy = ''
      render()
    }
  },

  async installFfmpeg() {
    state.busy = 'ffmpeg'
    state.ffmpegMsg = { kind: 'warn', text: '正在下载 Windows 便携版 ffmpeg 并校验（约 30–90 秒，请勿关闭页面）…' }
    render()
    let installedOk = false
    try {
      const res = await bridge.callTool('whale_app_ops', { action: 'install_ffmpeg' })
      installedOk = true
      state.ffmpegMsg = {
        kind: 'ok',
        text: res.alreadyInstalled
          ? `✓ 本机已可用 ffmpeg（${res.version || '已就绪'}），路径：${res.path}`
          : `✓ ffmpeg 安装完成（${res.version || '已就绪'}），已安装至：${res.path}`,
      }
    } catch (e) {
      state.ffmpegMsg = {
        kind: 'err',
        text: '一键安装 ffmpeg 失败：' + e.message + '。也可在 Windows 终端手动运行：winget install -e --id Gyan.FFmpeg',
      }
    } finally {
      state.busy = ''
      render()
    }
    if (installedOk) void actions.runDeps()
  },

  async refreshStatus() {
    try {
      state.status = await bridge.callTool('whale_app_ops', { action: 'status' })
      render()
    } catch {}
  },

  async refreshMemoryOverview() {
    state.busy = 'memory'
    render()
    try {
      const [st, lf] = await Promise.all([
        bridge.callTool('whale_app_ops', { action: 'status' }),
        bridge.callTool('whale_app_life', { action: 'status', params: {} }),
      ])
      state.status = st
      if (lf.state) state.lifeState = lf.state
      state.lifeLoaded = true
    } catch (e) {
      state.lifeError = e.message
    } finally {
      state.busy = ''
      render()
    }
  },

  async saveOwnerNote() {
    const text = String(state.lifeNote || '').trim()
    if (!text) return
    state.busy = 'life'
    state.lifeError = ''
    state.lifeMsg = ''
    render()
    try {
      const res = await bridge.callTool('whale_app_life', { action: 'owner-note', params: { text } })
      if (res.state) state.lifeState = res.state
      state.lifeNote = ''
      state.lifeMsg = '✓ 已记录你的偏好说明，大鲸鱼会在后台记忆归纳时吸收'
    } catch (e) {
      state.lifeError = e.message
    } finally {
      state.busy = ''
      render()
    }
  },

  async searchExperiences() {
    state.busy = 'life'
    state.lifeError = ''
    render()
    try {
      const res = await bridge.callTool('whale_app_life', { action: 'search', params: { query: state.lifeQuery } })
      if (res.state) state.lifeState = res.state
      const raw = res.result
      state.lifeSearchItems = Array.isArray(raw) ? raw : (Array.isArray(raw?.items) ? raw.items : (Array.isArray(raw?.events) ? raw.events : []))
    } catch (e) {
      state.lifeError = e.message
    } finally {
      state.busy = ''
      render()
    }
  },

  async runLife(action, params = {}) {
    state.busy = 'life'
    state.lifeError = ''
    state.lifeMsg = ''
    render()
    try {
      const res = await bridge.callTool('whale_app_life', { action, params })
      if (res.state) state.lifeState = res.state
      state.lifeLoaded = true
      if (action === 'export') {
        const d = new Date()
        const stamp = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}-${String(d.getHours()).padStart(2, '0')}${String(d.getMinutes()).padStart(2, '0')}`
        downloadJson(`antigravity-whale-memory-${stamp}.json`, res.result)
        state.lifeMsg = '✓ 已导出长期记忆备份文件'
      }
    } catch (e) {
      state.lifeError = e.message
    } finally {
      state.busy = ''
      render()
    }
  },
}

function isDirty() {
  return Boolean(state.cfg && state.savedJson && JSON.stringify(state.cfg) !== state.savedJson)
}

function updateSaveStatePill() {
  const pill = document.getElementById('save-state-pill')
  if (!pill) return
  const dirty = isDirty()
  pill.className = 'pill ' + (dirty ? 'warn' : 'ok')
  const txt = pill.querySelector('.save-state-txt')
  if (txt) txt.textContent = dirty ? '有未保存更改' : '配置已保存'
}

function render() {
  if (!state.ready || !state.cfg) {
    mount(
      state.banner ? el('div', { className: 'banner ' + state.banner.kind }, state.banner.text) : null,
      el('div', { className: 'loading-box' }, '正在读取哔哩哔哩大鲸鱼控制台…'))
    return
  }

  const tabs = [
    ['account', '大鲸鱼与主人'],
    ['persona', '人设与作息'],
    ['models', '模型选择'],
    ['watch', '视频观看设置'],
    ['interact', '分享与监听'],
    ['memory', '动态与记忆'],
    ['env', '环境与依赖'],
    ['about', '关于与更新'],
  ]

  const dirty = isDirty()
  const topbar = el('header', { className: 'topbar' },
    el('div', { className: 'brand' },
      el('h1', {}, '哔哩哔哩大鲸鱼'),
      el('span', { id: 'save-state-pill', className: 'pill ' + (dirty ? 'warn' : 'ok') },
        el('span', { className: 'dot' }),
        el('span', { className: 'save-state-txt' }, dirty ? '有未保存更改' : '配置已保存'))),
    el('div', { className: 'actions' },
      el('button', { type: 'button', className: 'btn primary', disabled: !!state.busy, onClick: actions.saveSettings }, state.busy === 'save' ? '保存中…' : '保存配置'),
      el('button', { type: 'button', className: 'btn', disabled: !!state.busy, onClick: actions.bootstrap }, '重新读取')))

  const nav = el('nav', { className: 'tabs', role: 'tablist' },
    ...tabs.map(([id, label]) => el('button', {
      type: 'button',
      className: 'tab-btn' + (state.tab === id ? ' active' : ''),
      onClick: () => switchTab(id),
    }, label)))

  let body
  if (state.tab === 'account') body = renderAccountTab(state, actions)
  else if (state.tab === 'persona') body = renderPersonaTab(state, actions)
  else if (state.tab === 'models') body = renderModelsTab(state, actions)
  else if (state.tab === 'watch') body = renderWatchTab(state, actions)
  else if (state.tab === 'interact') body = renderInteractTab(state, actions)
  else if (state.tab === 'memory') body = renderMemoryTab(state, actions)
  else if (state.tab === 'env') body = renderEnvTab(state, actions)
  else body = renderAboutTab(state, actions)

  mount(
    topbar,
    nav,
    state.banner ? el('div', { className: 'banner ' + state.banner.kind }, state.banner.text) : null,
    body)
}

async function boot() {
  try {
    await bridge.connect()
    await actions.bootstrap()
  } catch (e) {
    mount(el('div', { className: 'banner err' }, '连接 Antigravity 宿主失败：' + String(e?.message ?? e)))
  }
}

void boot()
