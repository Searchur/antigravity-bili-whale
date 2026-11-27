import { createMcpBridge } from './bridge.mjs'
import {
  el,
  setPath,
  renderAccountTab,
  renderPersonaTab,
  renderInteractTab,
  renderEnvTab,
} from './views/sections.mjs'
import { renderModelsTab } from './views/models.mjs'
import { renderWatchTab } from './views/watch.mjs'
import { renderMemoryTab } from './views/memory.mjs'
import { renderAboutTab } from './views/about.mjs'

const state = {
  ready: false,
  tab: 'account',
  busy: '',
  banner: null,
  cfg: null,
  savedJson: '',
  accountRevision: 0,
  personaText: '',
  personaBytes: 0,
  personaPath: '',
  personaMsg: null,
  wakeMsg: null,
  likeTagDraft: '',
  dislikeTagDraft: '',
  safetyWordDraft: '',
  ownerCheck: null,
  ownerCheckErr: '',
  confirmLogout: false,
  logoutMsg: null,
  qr: null,
  qrError: '',
  modelCatalog: null,
  modelRole: 'main',
  modelsError: '',
  status: null,
  depsData: null,
  depsLoaded: false,
  diagExport: null,
  diagErr: '',
  about: null,
  pathMsg: null,
  updateCheck: null,
  updateResult: null,
  updateError: '',
  copiedKey: '',
  calMonth: '',
  calSelectedDate: '',
  lifeState: null,
  lifeLoaded: false,
  lifeQuery: '',
  lifeLimit: 20,
  lifeSearchLimitUsed: 20,
  lifeReceipt: '',
  lifeVerified: false,
  lifeSearchItems: null,
  memoryExport: null,
  lifeError: '',
}

const qrFlow = { gen: 0, id: null, timer: null }
const root = document.getElementById('root')
let savedIdentity = ''
let identityRevision = 0
let editsDuringSave = null

function rememberSavedConfig(config) {
  const key = JSON.stringify([String(config.self?.mid ?? ''), String(config.owner?.mid ?? '')])
  if (key !== savedIdentity) {
    savedIdentity = key
    identityRevision++
    Object.assign(state, {
      status: null, lifeState: null, lifeLoaded: false, lifeSearchItems: null,
      lifeQuery: '', lifeReceipt: '', lifeVerified: false, lifeError: '', memoryExport: null,
      calMonth: '', calSelectedDate: '', diagExport: null, diagErr: '',
      depsData: null, depsLoaded: false, ownerCheck: null, ownerCheckErr: '',
    })
  }
  state.savedJson = JSON.stringify(config)
}

function mount(...nodes) {
  root.replaceChildren(...nodes.filter(Boolean))
}

function setBanner(kind, text) {
  state.banner = text ? { kind, text } : null
  render()
}

function applySavedAccount(account) {
  if (!state.cfg) return
  const self = { mid: account.mid, name: account.name }
  const saved = JSON.parse(state.savedJson)
  state.cfg.self = self
  saved.self = self
  rememberSavedConfig(saved)
  state.accountRevision++
}

const bridge = createMcpBridge({
  onInitialResult: (payload) => {
    if (payload?.settings?.config && !state.cfg) {
      state.cfg = payload.settings.config
      rememberSavedConfig(payload.settings.config)
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
  if (id === 'persona') void actions.refreshStatus()
  if (id === 'models') {
    void actions.refreshStatus()
    if (state.modelCatalog?.source !== 'live') void actions.refreshModels()
  }
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

  async openPath(key, filename = '') {
    state.pathMsg = null
    try {
      const res = await bridge.callTool('whale_app_ops', {
        action: 'open_path',
        key,
        ...(filename ? { filename } : {}),
      })
      if (res?.detail && state.tab === 'about') {
        state.pathMsg = { kind: 'warn', text: res.detail }
        render()
      }
    } catch (e) {
      if (state.tab === 'about') {
        state.pathMsg = { kind: 'err', text: '打开目录失败：' + e.message }
        render()
      } else if (state.tab === 'env') {
        state.diagErr = '打开目录失败：' + e.message
        render()
      } else if (state.tab === 'memory') {
        state.lifeError = '打开目录失败：' + e.message
        render()
      } else {
        setBanner('err', '打开目录失败：' + e.message)
      }
    }
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
    editsDuringSave?.push([pathArr, structuredClone(value)])
    if (shouldRender) render()
    else updateSaveStatePill()
  },

  setModelRole(role) {
    state.modelRole = role === 'worker' ? 'worker' : 'main'
    render()
  },

  selectModel(role, modelId) {
    if (!state.cfg || !modelId) return
    actions.setCfg(['models', role === 'worker' ? 'worker' : 'main'], modelId, true)
  },

  async logout() {
    cancelQrInternal()
    state.accountRevision++
    state.busy = 'logout'
    state.logoutMsg = null
    render()
    try {
      const res = await bridge.callTool('whale_app_auth', { action: 'logout' })
      state.confirmLogout = false
      state.qr = null
      state.qrError = ''
      applySavedAccount({ mid: '', name: '' })
      state.depsLoaded = false
      const confirmed = res.remoteRevoked || res.remoteStatus === 'no_credentials'
      state.logoutMsg = { kind: confirmed ? 'ok' : 'warn', text: res.detail || '已清除本地凭据' }
    } catch (e) {
      state.logoutMsg = { kind: 'err', text: '退出登录失败：' + e.message }
    } finally {
      state.busy = ''
      render()
    }
  },

  async verifyOwner() {
    const mid = String(state.cfg?.owner?.mid ?? '').trim()
    const name = String(state.cfg?.owner?.name ?? '').trim()
    const revision = identityRevision
    const stillCurrent = () => revision === identityRevision && mid === String(state.cfg?.owner?.mid ?? '').trim() && name === String(state.cfg?.owner?.name ?? '').trim()
    state.busy = 'verify_owner'
    state.ownerCheck = null
    state.ownerCheckErr = ''
    render()
    try {
      const check = await bridge.callTool('whale_app_ops', { action: 'verify_owner', mid, name })
      if (stillCurrent()) state.ownerCheck = { ...check, checkedMid: mid }
    } catch (e) {
      if (stillCurrent()) state.ownerCheckErr = e.message
    } finally {
      state.busy = ''
      render()
    }
  },

  applyOwnerName(actualName) {
    if (!actualName || state.ownerCheck?.actualName !== actualName || state.ownerCheck.checkedMid !== String(state.cfg?.owner?.mid ?? '').trim()) return
    actions.setCfg(['owner', 'name'], actualName)
    if (state.ownerCheck) {
      state.ownerCheck = {
        ...state.ownerCheck,
        matched: true,
        expectedName: actualName,
        detail: `已同步为 B 站实际昵称「${actualName}」（记得点击右上角「保存配置」）`,
      }
    }
    render()
  },

  async bootstrap() {
    const revision = state.accountRevision
    state.busy = 'load'
    render()
    try {
      const res = await bridge.callTool('whale_app_bootstrap')
      if (revision !== state.accountRevision) return
      state.cfg = res.settings?.config ?? {}
      rememberSavedConfig(state.cfg)
      state.accountRevision++
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
      if (revision === state.accountRevision) setBanner('err', '加载配置失败：' + e.message)
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
      if (res.local) state.about = { ...(state.about ?? { ok: true }), local: res.local }
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
      state.updateResult = { kind: 'ok', text: res.message }
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
    if (editsDuringSave) return false
    editsDuringSave = []
    const accountRevision = state.accountRevision
    state.busy = 'save'
    state.banner = null
    render()
    try {
      const res = await bridge.callTool('whale_app_settings', { action: 'save', config: structuredClone(state.cfg) })
      if (res.config) {
        if (accountRevision !== state.accountRevision) res.config.self = state.cfg.self
        state.cfg = res.config
        rememberSavedConfig(res.config)
        for (const [field, value] of editsDuringSave) setPath(state.cfg, field, value)
        state.accountRevision++
      }
      if (res.warn) setBanner('warn', res.warn)
      else state.banner = null
      return true
    } catch (e) {
      setBanner('err', '保存失败：' + e.message)
      return false
    } finally {
      editsDuringSave = null
      state.busy = ''
      render()
    }
  },

  async savePersona() {
    state.busy = 'persona'
    state.personaMsg = null
    render()
    try {
      const res = await bridge.callTool('whale_app_persona', { action: 'save', text: state.personaText })
      state.personaBytes = res.bytes ?? 0
      state.personaMsg = { kind: 'ok', text: res.detail || '已保存' }
    } catch (e) {
      state.personaMsg = { kind: 'err', text: e.message }
    } finally {
      state.busy = ''
      render()
    }
  },

  async wakeNow() {
    state.busy = 'wake_now'
    state.wakeMsg = null
    render()
    let ok = false
    try {
      const res = await bridge.callTool('whale_app_ops', { action: 'wake_now' })
      ok = true
      state.wakeMsg = { kind: 'ok', text: res.detail || '已立即唤醒大鲸鱼，正在后台逛 B 站并看视频。' }
    } catch (e) {
      state.wakeMsg = { kind: 'err', text: '唤醒失败：' + e.message }
    } finally {
      state.busy = ''
      render()
    }
    if (ok) void actions.refreshStatus()
  },

  async qrStart() {
    cancelQrInternal()
    state.confirmLogout = false
    state.logoutMsg = null
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
            if (r.account && !r.account.warn) applySavedAccount(r.account)
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
    const accountRevision = state.accountRevision
    const revision = identityRevision
    state.busy = 'deps'
    render()
    try {
      const { report: j } = await bridge.callTool('whale_app_ops', { action: 'deps' })
      if (revision !== identityRevision) return
      if (j?.self && state.accountRevision === accountRevision) applySavedAccount(j.self)
      if (Array.isArray(j?.cards) && j.cards.length > 0) {
        state.depsData = j
      } else {
        state.depsData = {
          ok: false,
          cards: [
            {
              key: 'deps-probe',
              name: '环境与依赖检测',
              ok: false,
              status: 'error',
              version: '检测异常',
              detail: '本次环境检测未能返回完整结果，请稍后点击「重新检测」',
              action: null,
            },
          ],
        }
      }
      state.depsLoaded = true
    } catch {
      if (revision !== identityRevision) return
      state.depsData = {
        ok: false,
        cards: [
          {
            key: 'deps-probe',
            name: '环境与依赖检测服务',
            ok: false,
            status: 'error',
            version: '暂不可用',
            detail: '未能连接到插件环境检测接口，请确认插件正在运行后点击「重新检测」',
            action: null,
          },
        ],
      }
      state.depsLoaded = true
    } finally {
      state.busy = ''
      render()
    }
  },

  async exportDiagnostics() {
    const revision = identityRevision
    state.busy = 'export_diag'
    state.diagExport = null
    state.diagErr = ''
    render()
    try {
      const res = await bridge.callTool('whale_app_ops', { action: 'export_diag' })
      if (revision !== identityRevision) return
      state.diagExport = {
        label: '脱敏诊断日志',
        filename: res.filename,
        filePath: res.filePath,
        dirPath: res.dirPath,
        bytes: res.bytes,
      }
    } catch (e) {
      if (revision === identityRevision) state.diagErr = '导出诊断日志失败：' + e.message
    } finally {
      state.busy = ''
      render()
    }
  },

  selectCalDay(dayStr) {
    if (!dayStr) return
    state.calSelectedDate = dayStr
    state.calMonth = dayStr.slice(0, 7)
    render()
  },

  shiftCalMonth(delta) {
    const base = state.calMonth || state.status?.calendar?.today?.slice(0, 7) || new Date().toLocaleDateString('sv-SE').slice(0, 7)
    const [y, m] = base.split('-').map(n => Number.parseInt(n, 10))
    const d = new Date(y, (m || 1) - 1 + delta, 1)
    state.calMonth = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
    render()
  },

  jumpCalToday() {
    const today = state.status?.calendar?.today || new Date().toLocaleDateString('sv-SE')
    state.calSelectedDate = today
    state.calMonth = today.slice(0, 7)
    render()
  },

  async refreshStatus() {
    const revision = identityRevision
    try {
      const status = await bridge.callTool('whale_app_ops', { action: 'status' })
      if (revision !== identityRevision) return
      state.status = status
      render()
    } catch {}
  },

  async refreshMemoryOverview() {
    const revision = identityRevision
    state.busy = 'memory'
    render()
    try {
      const [st, lf] = await Promise.all([
        bridge.callTool('whale_app_ops', { action: 'status' }),
        bridge.callTool('whale_app_life', { action: 'status', params: {} }),
      ])
      if (revision !== identityRevision) return
      state.status = st
      if (lf.state) state.lifeState = lf.state
      state.lifeLoaded = true
    } catch (e) {
      if (revision === identityRevision) state.lifeError = e.message
    } finally {
      state.busy = ''
      render()
    }
  },

  async searchExperiences() {
    const revision = identityRevision
    state.busy = 'life'
    state.lifeError = ''
    render()
    try {
      const limit = [20, 50, 100].includes(Number(state.lifeLimit)) ? Number(state.lifeLimit) : 20
      const res = await bridge.callTool('whale_app_life', { action: 'search', params: { query: state.lifeQuery, limit } })
      if (revision !== identityRevision) return
      if (res.state) state.lifeState = res.state
      state.lifeSearchLimitUsed = Number(res.limit) || limit
      const raw = res.result
      state.lifeSearchItems = Array.isArray(raw) ? raw : (Array.isArray(raw?.items) ? raw.items : (Array.isArray(raw?.events) ? raw.events : []))
    } catch (e) {
      if (revision === identityRevision) state.lifeError = e.message
    } finally {
      state.busy = ''
      render()
    }
  },

  async runLife(action, params = {}) {
    const revision = identityRevision
    state.busy = 'life'
    state.lifeError = ''
    if (action === 'export') state.memoryExport = null
    render()
    try {
      const res = await bridge.callTool('whale_app_life', { action, params })
      if (revision !== identityRevision) return
      if (res.state) state.lifeState = res.state
      state.lifeLoaded = true
      if (action === 'export') {
        state.memoryExport = {
          label: '长期记忆备份',
          filename: res.filename,
          filePath: res.filePath,
          dirPath: res.dirPath,
          bytes: res.bytes,
        }
      }
    } catch (e) {
      if (revision === identityRevision) state.lifeError = e.message
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
