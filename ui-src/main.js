import { createMcpBridge } from './bridge.js'
import {
  el,
  setPath,
  renderAccountTab,
  renderPersonaTab,
  renderInteractTab,
  renderPendingTab,
  renderRuntimeTab,
} from './render-sections.js'
import { renderModelsTab } from './render-models.js'
import { renderMemoryTab } from './render-memory.js'

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
  qr: null,
  qrError: '',
  modelCatalog: null,
  modelRole: 'main',
  modelsError: '',
  status: null,
  pending: [],
  pendingMsg: '',
  depsData: null,
  depsLoaded: false,
  depsError: '',
  ffmpegMsg: null,
  notifyOut: '',
  triggerOut: '',
  lifeState: null,
  lifeLoaded: false,
  lifeQuery: '',
  lifeNote: '',
  lifeProposal: '{"type":"memory","text":"","sourceIds":[],"visibility":"private"}',
  lifeEventId: '',
  lifeReceipt: '',
  lifeVerified: false,
  lifeResult: '',
  lifeError: '',
  corpusStatus: null,
  corpusItems: [],
  corpusTotal: 0,
  corpusFilter: 'pending',
  corpusOffset: 0,
  corpusChosen: null,
  corpusTopic: 'general',
  corpusIntent: 'reaction',
  corpusNote: '',
  corpusAck: false,
  corpusError: '',
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
      state.pending = payload.pending?.items ?? state.pending
      if (payload.models) state.modelCatalog = payload.models
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
  if (id === 'pending') void actions.refreshPending()
  if (id === 'runtime') {
    void actions.refreshStatus()
    if (!state.depsLoaded) void actions.runDeps()
  }
  if (id === 'memory' && !state.lifeLoaded) {
    void actions.runLife('status').then(() => actions.runCorpus('list'))
  }
}

const actions = {
  rerender: () => render(),
  switchTab,

  setCfg(pathArr, value, shouldRender = false) {
    if (!state.cfg) return
    setPath(state.cfg, pathArr, value)
    if (shouldRender) render()
    else updateDirtyBadge()
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
      state.pending = res.pending?.items ?? []
      if (res.models) state.modelCatalog = res.models
      state.ready = true
      state.banner = null
    } catch (e) {
      setBanner('err', '加载配置失败：' + e.message)
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
      state.depsError = '依赖体检失败：' + e.message
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

  async notifyTest() {
    state.busy = 'notify'
    state.notifyOut = '先保存当前设置，再发送测试消息…'
    render()
    try {
      const saved = await actions.saveSettings()
      if (!saved) { state.notifyOut = '✗ 设置保存失败，未发送测试'; return }
      state.busy = 'notify'
      render()
      const res = await bridge.callTool('whale_app_ops', { action: 'notify_test' })
      state.notifyOut = (res.ok ? '✓ 测试通知已发送\n' : '✗ 测试发送失败\n') + (res.out || '') + (res.err ? '\n' + res.err : '')
    } catch (e) {
      state.notifyOut = '✗ ' + e.message
    } finally {
      state.busy = ''
      render()
    }
  },

  async triggerNight(dry) {
    state.busy = 'trigger'
    state.triggerOut = dry ? '正在预演手工唤醒…' : '正在提交手工唤醒并通知后台守护…'
    render()
    try {
      const res = await bridge.callTool('whale_app_ops', { action: 'trigger_night', dry })
      state.triggerOut = res.result ? JSON.stringify(res.result, null, 2) : (res.out || res.err || '完成')
    } catch (e) {
      state.triggerOut = '✗ ' + e.message
    } finally {
      state.busy = ''
      render()
    }
  },

  async refreshStatus() {
    state.busy = 'status'
    render()
    try {
      state.status = await bridge.callTool('whale_app_ops', { action: 'status' })
    } catch (e) {
      setBanner('err', '刷新运行状态失败：' + e.message)
    } finally {
      state.busy = ''
      render()
    }
  },

  async refreshPending() {
    state.busy = 'pending'
    render()
    try {
      const res = await bridge.callTool('whale_app_pending', { action: 'list' })
      state.pending = res.items ?? []
    } catch (e) {
      state.pendingMsg = '✗ 刷新队列失败：' + e.message
    } finally {
      state.busy = ''
      render()
    }
  },

  async approvePending(id) {
    state.busy = 'approve:' + id
    state.pendingMsg = ''
    render()
    try {
      const res = await bridge.callTool('whale_app_pending', { action: 'approve', id })
      state.pendingMsg = res.ok ? `✓ 已发出${res.rpid ? ' · rpid=' + res.rpid : ''}` : `✗ 发送失败：${res.err || res.out || '请查看日志'}`
      await actions.refreshPending()
    } catch (e) {
      state.pendingMsg = '✗ ' + e.message
    } finally {
      state.busy = ''
      render()
    }
  },

  async rejectPending(id) {
    state.busy = 'reject:' + id
    state.pendingMsg = ''
    render()
    try {
      await bridge.callTool('whale_app_pending', { action: 'reject', id })
      state.pendingMsg = '✓ 已删除并记录否决反馈'
      await actions.refreshPending()
    } catch (e) {
      state.pendingMsg = '✗ ' + e.message
    } finally {
      state.busy = ''
      render()
    }
  },

  async runLife(action, params = {}) {
    state.busy = 'life'
    state.lifeError = ''
    render()
    try {
      const res = await bridge.callTool('whale_app_life', { action, params })
      if (res.state) state.lifeState = res.state
      state.lifeLoaded = true
      if (action === 'export') downloadJson('antigravity-whale-life-export.json', res.result)
      else if (res.result !== undefined) state.lifeResult = JSON.stringify(res.result, null, 2)
    } catch (e) {
      state.lifeError = e.message
    } finally {
      state.busy = ''
      render()
    }
  },

  submitProposal() {
    try {
      const parsed = JSON.parse(state.lifeProposal)
      void actions.runLife('propose', { proposal: parsed })
    } catch (e) {
      state.lifeError = 'JSON 格式错误：' + e.message
      render()
    }
  },

  async runCorpus(action = 'list', extra = {}) {
    state.busy = 'corpus'
    state.corpusError = ''
    render()
    try {
      const res = await bridge.callTool('whale_app_corpus', {
        action,
        params: { status: state.corpusFilter, offset: state.corpusOffset, limit: 10, ...extra },
      })
      if (res.state) state.corpusStatus = res.state
      if (action === 'list') {
        state.corpusItems = res.result?.items ?? []
        state.corpusTotal = res.result?.total ?? 0
      } else if (action === 'export') {
        downloadJson('antigravity-whale-corpus-export.json', res.result)
      } else {
        state.corpusChosen = null
        await actions.runCorpus('list')
        return
      }
    } catch (e) {
      state.corpusError = e.message
    } finally {
      state.busy = ''
      render()
    }
  },
}

function isDirty() {
  return Boolean(state.cfg && state.savedJson && JSON.stringify(state.cfg) !== state.savedJson)
}

function updateDirtyBadge() {
  const badge = document.getElementById('dirty-pill')
  if (badge) badge.style.display = isDirty() ? 'inline-flex' : 'none'
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
    ['interact', '分享与监听'],
    ['pending', '待审回复', state.pending.length],
    ['runtime', '运行与体检'],
    ['memory', '记忆与语料'],
  ]

  const topbar = el('header', { className: 'topbar' },
    el('div', { className: 'brand' },
      el('h1', {}, '哔哩哔哩大鲸鱼'),
      el('span', { className: 'pill ' + (state.status?.sidecarRunning ? 'ok' : 'warn') },
        el('span', { className: 'dot' }),
        state.status?.sidecarRunning ? '后台守护运行中' : '守护未连接'),
      state.cfg.self?.mid
        ? el('span', { className: 'pill' }, `${state.cfg.self.name || '已登录'} (${state.cfg.self.mid})`)
        : el('span', { className: 'pill warn' }, '未登录 B 站'),
      el('span', { id: 'dirty-pill', className: 'pill warn', style: { display: isDirty() ? 'inline-flex' : 'none' } }, '有未保存更改')),
    el('div', { className: 'actions' },
      el('button', { type: 'button', className: 'btn primary', disabled: !!state.busy, onClick: actions.saveSettings }, state.busy === 'save' ? '保存中…' : '保存配置'),
      el('button', { type: 'button', className: 'btn', disabled: !!state.busy, onClick: actions.bootstrap }, '重新读取')))

  const nav = el('nav', { className: 'tabs', role: 'tablist' },
    ...tabs.map(([id, label, count]) => el('button', {
      type: 'button',
      className: 'tab-btn' + (state.tab === id ? ' active' : ''),
      onClick: () => switchTab(id),
    }, label, count > 0 ? el('span', { className: 'badge-count' }, count) : null)))

  let body
  if (state.tab === 'account') body = renderAccountTab(state, actions)
  else if (state.tab === 'persona') body = renderPersonaTab(state, actions)
  else if (state.tab === 'models') body = renderModelsTab(state, actions)
  else if (state.tab === 'interact') body = renderInteractTab(state, actions)
  else if (state.tab === 'pending') body = renderPendingTab(state, actions)
  else if (state.tab === 'runtime') body = renderRuntimeTab(state, actions)
  else body = renderMemoryTab(state, actions)

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
