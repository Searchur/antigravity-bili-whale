/**
 * 控制台后端业务处理器：封装配置读写、扫码登录与登出、主人核验、环境检测、运行状态与记忆管理 API。
 */
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { execFile, spawn } from 'node:child_process'
import {
  PLUGIN_ROOT,
  biliCliPath,
  behaviorRoot,
  safetyRulesPath,
  WHALE_HOME,
  configPath,
  credentialsPath,
  personaPath,
  dataPathsFor,
} from '../core/paths.mjs'
import {
  DEFAULTS,
  BROWSE_DEFAULTS,
  LISTEN_DEFAULTS,
  MODEL_DEFAULTS,
  FAN_LIMITS_DEFAULTS,
  SAFETY_DEFAULTS,
  MAX_LIKE_TAGS,
  MAX_DISLIKE_TAGS,
  MAX_PERSONA_CHARS,
  normalizeModels,
  normalizeWatch,
  normalizeListen,
  normalizeFanLimits,
  normalizeSafety,
  withoutRetiredListening,
} from '../config/index.mjs'
import { CHAT_DEFAULTS, chatConfig } from '../config/chat.mjs'
import { LIFE_DEFAULTS, lifeConfig } from '../config/life.mjs'
import { atomicWriteJson } from '../core/atomic-json.mjs'
import { windowIssues, normalizeTimeText } from '../config/night-plan.mjs'
import { lifeStore } from '../life/runtime.mjs'
import { diagnose } from '../core/diagnostics.mjs'
import { RISK_DEFAULTS } from '../bili/traffic.mjs'
import { ffmpegInfo } from '../media/ffmpeg.mjs'
import { readFanQuotaSummary } from '../social/fan-quota.mjs'
import { readRecentSafetyBlocks } from '../social/content-safety.mjs'
import { clearRelationCache } from '../bili/relation.mjs'
import { buildActivityCalendar } from './activity-stats.mjs'
import { createCredentialStore } from '../bili/credential-store.mjs'
import { QrAuth, verifyAccount } from '../bili/auth.mjs'
import { deliveryStatus } from '../daemon/delivery-state.mjs'
import { readSchedulerHealth } from '../daemon/scheduler-health.mjs'
import { resolveNodeRuntime, nodeEnv } from '../core/node-runtime.mjs'
import { callSidecarIpc } from '../host/sidecar-ipc.mjs'
import { UNAVAILABLE_MODEL_USAGE } from '../host/model-usage.mjs'
import { createAntigravityRpc, fallbackModelCatalog } from '../host/rpc.mjs'
import { readLocalPluginMeta, checkForUpdate, applyPluginUpdate } from '../plugin/updater.mjs'

const BASE_DEFAULTS = {
  ...DEFAULTS,
  browse: { ...BROWSE_DEFAULTS },
  chat: { ...CHAT_DEFAULTS },
  life: { ...LIFE_DEFAULTS, autonomy: false },
  models: { ...MODEL_DEFAULTS },
  fanLimits: { ...FAN_LIMITS_DEFAULTS },
  safety: { ...SAFETY_DEFAULTS, customWords: [] },
  risk: RISK_DEFAULTS,
  listen: { ...LISTEN_DEFAULTS },
}

const KNOWN_TOP_KEYS = new Set([
  'browse', 'persona', 'preferences', 'aliases', 'owner', 'quota', 'share',
  'listen', 'night', 'risk', 'sessionRotateDays', 'life', 'chat', 'models', 'watch',
  'fanLimits', 'safety',
])

const merge = (base, over) => {
  const out = { ...base }
  for (const [k, v] of Object.entries(over || {})) {
    out[k] = v && typeof v === 'object' && !Array.isArray(v) ? merge(base[k] ?? {}, v) : v
  }
  return out
}

function pad2(n) { return String(n).padStart(2, '0') }
function fileTimestamp(d = new Date()) {
  return `${d.getFullYear()}${pad2(d.getMonth() + 1)}${pad2(d.getDate())}-${pad2(d.getHours())}${pad2(d.getMinutes())}${pad2(d.getSeconds())}`
}

function defaultOpenInExplorer(targetPath, { selectFile = false } = {}) {
  const normalized = path.resolve(targetPath)
  const args = selectFile ? ['/select,', normalized] : [normalized]
  const child = spawn('explorer.exe', args, {
    detached: true,
    stdio: 'ignore',
    windowsHide: false,
  })
  child.unref()
}

const EXPORT_FILENAME_RE = /^[a-zA-Z0-9._-]+\.json$/

/**
 * 与宿主完全解耦的管理面板业务 API 层（供 MCP App 专用工具调用，亦可独立单测）。
 */
export function createApiHandlers({
  pluginRoot = PLUGIN_ROOT,
  whaleHome = WHALE_HOME,
  cfgFile = configPath,
  credFile = credentialsPath,
  personaFile = personaPath,
  biliMjs = biliCliPath,
  ipcClient = callSidecarIpc,
  rpc = createAntigravityRpc(),
  verify = verifyAccount,
  qrFetch = globalThis.fetch,
  updateFetch = globalThis.fetch,
  updateExtractZip,
  openPathImpl = defaultOpenInExplorer,
} = {}) {
  const resolveNode = () => resolveNodeRuntime(whaleHome)

  function execNode(args, options = {}) {
    return new Promise((resolve) => {
      let nodeExe
      try { nodeExe = resolveNode() }
      catch (e) { resolve({ ok: false, stdout: '', stderr: String(e?.message ?? e), err: e }); return }
      execFile(nodeExe, args, {
        windowsHide: true,
        timeout: 60_000,
        maxBuffer: 8 * 1024 * 1024,
        ...options,
        env: { ...nodeEnv(whaleHome), BILI_WHALE_HOME: whaleHome, BILI_WHALE_CONFIG: cfgFile, ...options.env },
      }, (err, stdout, stderr) => {
        resolve({ ok: !err, err, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') })
      })
    })
  }

  function readConfig() {
    let user = {}
    try {
      user = JSON.parse(fs.readFileSync(cfgFile, 'utf8'))
      if (!user || Array.isArray(user) || typeof user !== 'object') throw Error('config schema')
    } catch (e) {
      if (e.code !== 'ENOENT') {
        diagnose('settings-config-read', e)
        throw Error('配置文件损坏或不可读取，未使用默认值覆盖。')
      }
    }
    const merged = withoutRetiredListening({ ...merge(BASE_DEFAULTS, user), __hasUserFile: Object.keys(user).length > 0 })
    merged.browse = { enabled: user.browse?.enabled === true }
    merged.chat = chatConfig(merged.chat)
    if (merged.share && typeof merged.share === 'object') {
      delete merged.share.aiCommentGuard
      delete merged.share.aiThreshold
      delete merged.share.minScore
      delete merged.share.silentAfterDays
    }
    merged.models = normalizeModels(merged.models)
    merged.watch = normalizeWatch(user.watch)
    merged.listen = normalizeListen(user.listen ?? merged.listen)
    merged.fanLimits = normalizeFanLimits(merged.fanLimits)
    merged.safety = normalizeSafety(merged.safety)
    delete merged.diary
    delete merged.notify
    merged.life = { ...lifeConfig(merged.life), autonomy: false }
    merged.personaOncePerSession = true
    if (!String(merged.persona?.name ?? '').trim()) {
      merged.persona = { ...(merged.persona ?? {}), name: '大鲸鱼' }
    }
    return merged
  }

  function writeConfig(next) {
    const clean = withoutRetiredListening({ ...next })
    delete clean.__hasUserFile
    clean.browse = { enabled: clean.browse?.enabled === true }
    clean.chat = chatConfig(clean.chat)
    if (clean.share && typeof clean.share === 'object') {
      delete clean.share.aiCommentGuard
      delete clean.share.aiThreshold
      delete clean.share.minScore
      delete clean.share.silentAfterDays
    }
    clean.models = normalizeModels(clean.models)
    clean.watch = normalizeWatch(clean.watch)
    clean.listen = normalizeListen(clean.listen)
    clean.fanLimits = normalizeFanLimits(clean.fanLimits)
    clean.safety = normalizeSafety(clean.safety)
    delete clean.diary
    delete clean.notify
    clean.life = { ...lifeConfig(clean.life), autonomy: false }
    clean.personaOncePerSession = true
    if (!String(clean.persona?.name ?? '').trim()) {
      clean.persona = { ...(clean.persona ?? {}), name: '大鲸鱼' }
    }
    atomicWriteJson(cfgFile, clean, { pretty: true, mode: 0o600 })
  }

  function credState() {
    try {
      const c = JSON.parse(fs.readFileSync(credFile, 'utf8'))
      return { present: true, hasSess: !!c.sessdata, hasJct: !!c.bili_jct, hasBuvid: !!c.buvid3 }
    } catch {
      return { present: false, hasSess: false, hasJct: false, hasBuvid: false }
    }
  }

  const credentialStore = createCredentialStore({ file: credFile, verify })

  const saveLogin = async (credentials, options) => {
    const account = await credentialStore.save(credentials, options)
    clearRelationCache()
    try {
      const current = readConfig()
      writeConfig({ ...current, self: account })
    } catch {
      return { ...account, warn: '登录状态已保存，但账号显示信息未更新；请重新读取配置。' }
    }
    await ipcClient('/invalidate', { method: 'POST', body: { resetPlan: false } }).catch(() => {})
    return account
  }

  const qrAuth = new QrAuth({ save: saveLogin, fetch: qrFetch })
  let logoutFlight = null

  async function qrStart() {
    if (logoutFlight) throw new Error('正在退出登录，请完成后重新扫码。')
    return qrAuth.start()
  }

  async function revokeRemoteSession(credentials) {
    const cookieHeader = `SESSDATA=${credentials.sessdata}; bili_jct=${credentials.bili_jct}${credentials.buvid3 ? `; buvid3=${credentials.buvid3}` : ''}`
    const headers = { 'user-agent': 'Mozilla/5.0', referer: 'https://www.bilibili.com/', cookie: cookieHeader }
    const body = new URLSearchParams({ biliCSRF: String(credentials.bili_jct), gourl: 'https://www.bilibili.com/' })
    let exitAccepted = false
    try {
      const res = await qrFetch('https://passport.bilibili.com/login/exit/v2', {
        method: 'POST', redirect: 'manual', headers, body, signal: AbortSignal.timeout(8_000),
      })
      exitAccepted = [301, 302].includes(res.status) || (res.ok && (await res.json())?.code === 0)
    } catch {}
    try {
      const res = await qrFetch('https://api.bilibili.com/x/web-interface/nav', {
        redirect: 'error', headers, signal: AbortSignal.timeout(8_000),
      })
      const result = res.ok ? await res.json() : null
      if (result?.code === -101 || (result?.code === 0 && result.data?.isLogin === false)) return 'verified_revoked'
      if (result?.code === 0 && result.data?.isLogin === true) return 'still_active'
    } catch {}
    return exitAccepted ? 'exit_accepted' : 'local_only'
  }

  async function closeLoginSession() {
    qrAuth.cancel()
    let credentials
    let remoteStatus = 'no_credentials'
    try { credentials = JSON.parse(fs.readFileSync(credFile, 'utf8')) }
    catch (error) { if (error.code !== 'ENOENT') remoteStatus = 'local_only' }
    try { fs.rmSync(credFile, { force: true }) }
    catch { throw new Error('无法删除本地登录凭据，请检查文件权限后重试。') }

    clearRelationCache()
    try {
      const current = readConfig()
      writeConfig({ ...current, self: { mid: '', name: '' } })
    } catch (error) { diagnose('logout-config-clear', error) }
    const reload = ipcClient('/invalidate', { method: 'POST', body: { resetPlan: false } }).catch(() => {})
    if (credentials?.sessdata && credentials?.bili_jct) remoteStatus = await revokeRemoteSession(credentials)
    else if (credentials) remoteStatus = 'local_only'
    await reload

    const remoteDetail = {
      verified_revoked: '已复核 B 站远程会话失效。',
      still_active: 'B 站复核显示远程会话仍有效，可在 B 站安全中心下线旧设备。',
      exit_accepted: 'B 站已受理注销请求，暂未确认远程会话失效。',
      local_only: '暂未确认 B 站远程会话失效，可在 B 站安全中心下线旧设备。',
      no_credentials: '',
    }[remoteStatus]
    return {
      ok: true,
      remoteRevoked: remoteStatus === 'verified_revoked',
      remoteStatus,
      detail: `本地登录凭据已清除。${remoteDetail}`,
    }
  }

  function logout() {
    logoutFlight ??= closeLoginSession().finally(() => { logoutFlight = null })
    return logoutFlight
  }

  async function getSettings() {
    const config = readConfig()
    const credentials = credState()
    if (!credentials.hasSess || !credentials.hasJct) config.self = { mid: '', name: '' }
    return { ok: true, config, credentials, configPath: cfgFile, dataDir: whaleHome }
  }

  async function saveSettings(incomingRaw) {
    const cur = readConfig()
    const incoming = (incomingRaw && typeof incomingRaw.config === 'object' && incomingRaw.config) || incomingRaw || {}
    const filtered = {}
    for (const [k, v] of Object.entries(incoming)) {
      if (KNOWN_TOP_KEYS.has(k)) filtered[k] = v
    }
    const next = merge(cur, filtered)
    const rotateDays = Number(next.sessionRotateDays ?? DEFAULTS.sessionRotateDays)
    if (!Number.isFinite(rotateDays) || rotateDays < 0 || rotateDays > 365) {
      throw Error('会话轮换天数须为 0–365。')
    }
    next.sessionRotateDays = Math.floor(rotateDays)
    next.personaOncePerSession = true
    next.browse = { enabled: next.browse?.enabled === true }

    const n = next.night
    if (!Array.isArray(n.windows) || !n.windows.length) throw Error('至少需要配置一个作息时间窗。')
    n.windows = n.windows.map(w => (w && typeof w === 'object'
      ? {
          ...w,
          start: normalizeTimeText(w.start),
          end: normalizeTimeText(w.end),
          wakes: Math.min(12, Math.max(1, Math.floor(Number(w.wakes) || 1))),
        }
      : w))
    const windowProblems = windowIssues({ windows: n.windows })
    if (windowProblems.length) {
      throw Error(windowProblems[0].message)
    }
    const totalWakes = Math.max(1, n.windows.reduce((sum, w) => sum + (Number(w?.wakes) || 1), 0))
    n.maxWakesPerDay = Math.min(12, totalWakes)
    const rawSkip = Number(n.skipChance)
    const snappedSkip = Number.isFinite(rawSkip)
      ? Math.min(0.8, Math.max(0, Math.round(rawSkip * 5) / 5))
      : 0.2
    n.skipChance = Number(snappedSkip.toFixed(1))
    n.minGapMin = Number.isFinite(Number(n.minGapMin)) ? Math.min(240, Math.max(10, Math.floor(Number(n.minGapMin)))) : 10
    n.maxVideos = Math.min(10, Math.max(1, Math.floor(Number(n.maxVideos) || 5)))
    n.deepWatchMax = Math.min(3, n.maxVideos, Math.max(1, Math.floor(Number(n.deepWatchMax) || 3)))

    const cleanTags = (arr) => [...new Set((Array.isArray(arr) ? arr : []).map(s => String(s ?? '').trim()).filter(Boolean))]
    const likeTags = cleanTags(next.preferences?.like)
    const dislikeTags = cleanTags(next.preferences?.dislike)
    if (likeTags.length > MAX_LIKE_TAGS) {
      throw Error(`喜欢的主题标签最多设置 ${MAX_LIKE_TAGS} 个（每次唤醒最多按已选主题检索，过多容易触发 B 站限流）。`)
    }
    if (dislikeTags.length > MAX_DISLIKE_TAGS) {
      throw Error(`屏蔽的主题标签最多设置 ${MAX_DISLIKE_TAGS} 个。`)
    }
    next.preferences = { ...(next.preferences ?? {}), like: likeTags, dislike: dislikeTags }

    const sd = Number(next.quota?.shareDaily)
    next.quota = { ...(next.quota ?? {}), shareDaily: Number.isFinite(sd) ? Math.min(10, Math.max(1, Math.floor(sd))) : 3 }
    next.life = { ...lifeConfig(next.life), autonomy: false }
    next.chat = chatConfig(next.chat)
    next.models = normalizeModels(next.models)
    next.watch = normalizeWatch(next.watch)
    next.listen = normalizeListen(incoming.listen ?? next.listen)
    next.fanLimits = normalizeFanLimits(next.fanLimits)
    next.safety = normalizeSafety(next.safety)
    if (!String(next.persona?.name ?? '').trim()) {
      next.persona = { ...(next.persona ?? {}), name: '大鲸鱼' }
    }

    if (cur.self?.mid && cur.owner?.mid && (
      ['enabled', 'learningEnabled', 'paused'].some(k => lifeConfig(cur.life)[k] !== next.life[k])
      || ['enabled', 'shadow'].some(k => lifeConfig(cur.life).dynamicMemory[k] !== next.life.dynamicMemory[k])
    )) {
      await lifeStore(cur, { whaleHome }).invalidateFormation()
    }
    writeConfig({ ...next, self: readConfig().self })

    const schedulingChanged = ['windows', 'skipChance', 'maxVideos', 'deepWatchMax', 'minGapMin'].some(
      key => JSON.stringify(cur.night?.[key]) !== JSON.stringify(next.night?.[key]),
    ) || cur.browse?.enabled !== next.browse?.enabled
    const ipc = await ipcClient('/invalidate', { method: 'POST', body: { resetPlan: schedulingChanged } })
    const reloadWarning = ipc.running ? null : '配置已保存，但后台守护尚未运行，将在后台守护启动时自动加载。'
    const quotaWarning = next.quota.shareDaily > 3 ? '每日分享上限超过 3 条，容易触发 B 站限流或风控。' : null
    const { config } = await getSettings()
    return { ok: true, config, configPath: cfgFile, warn: reloadWarning ?? quotaWarning }
  }

  async function getPersona() {
    let text = ''
    try { text = fs.readFileSync(personaFile, 'utf8') } catch (e) { if (e.code !== 'ENOENT') diagnose('host-optional-operation', e) }
    let updatedAt = null
    try { updatedAt = fs.statSync(personaFile).mtime.toISOString() } catch {}
    return { ok: true, text, bytes: Buffer.byteLength(text, 'utf8'), updatedAt, path: personaFile }
  }

  async function savePersona(rawText) {
    const text = String(rawText ?? '')
    if (text.length > MAX_PERSONA_CHARS) throw Error(`人设正文超过 ${MAX_PERSONA_CHARS} 字上限（当前 ${text.length} 字），请精简后再保存。`)
    fs.mkdirSync(path.dirname(personaFile), { recursive: true })
    fs.writeFileSync(personaFile, text, 'utf8')
    const bytes = Buffer.byteLength(text, 'utf8')
    return {
      ok: true,
      bytes,
      maxChars: MAX_PERSONA_CHARS,
      detail: text.trim()
        ? `人设已保存（${text.length} 字 / ${bytes} 字节），将于下一次唤醒生效。`
        : '人设已清空，将仅使用基础称呼配置。',
    }
  }

  async function verifyOwner(rawMid, rawExpectedName = '') {
    const mid = String(rawMid ?? '').trim()
    const expectedName = String(rawExpectedName ?? '').trim()
    if (!/^[1-9]\d{0,19}$/.test(mid)) {
      throw Error('主人 UID 格式不正确，请填写纯数字 B 站 UID（如 12345678）。')
    }
    let cookie = ''
    try {
      const c = JSON.parse(fs.readFileSync(credFile, 'utf8'))
      if (c?.sessdata) {
        cookie = `SESSDATA=${c.sessdata}${c.bili_jct ? `; bili_jct=${c.bili_jct}` : ''}${c.buvid3 ? `; buvid3=${c.buvid3}` : ''}`
      }
    } catch {}
    const headers = {
      'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
      referer: 'https://www.bilibili.com/',
      ...(cookie ? { cookie } : {}),
    }
    const res = await qrFetch(`https://api.bilibili.com/x/web-interface/card?mid=${encodeURIComponent(mid)}`, {
      headers,
      signal: AbortSignal.timeout(12_000),
    })
    if (!res.ok) throw Error(`请求 B 站接口失败（HTTP ${res.status}），请稍后重试。`)
    const json = await res.json()
    if (json?.code !== 0 || !json?.data?.card?.name) {
      const msg = json?.message || '未找到该 UID 对应的 B 站账号'
      throw Error(`核验失败：${msg}（code=${json?.code ?? 'unknown'}）。`)
    }
    const actualName = String(json.data.card.name).trim()
    const sign = String(json.data.card.sign ?? '').trim().slice(0, 80)
    if (!expectedName) {
      return {
        ok: true,
        matched: null,
        mid,
        actualName,
        expectedName: '',
        sign,
        detail: `已查到 UID ${mid} 对应的 B 站昵称为【${actualName}】，可点击一键填入。`,
      }
    }
    const matched = actualName === expectedName
    return {
      ok: true,
      matched,
      mid,
      actualName,
      expectedName,
      sign,
      detail: matched
        ? `核验通过：UID ${mid} 与昵称【${actualName}】一致。`
        : `核验不一致：UID ${mid} 在 B 站的实际昵称为【${actualName}】，与当前填写的【${expectedName}】不同。`,
    }
  }

  function resolveKnownPaths() {
    const dp = dataPathsFor(whaleHome, { cfgFile })
    return {
      pluginRoot,
      behaviorDir: path.join(pluginRoot, 'behavior'),
      dataDir: whaleHome,
      configFile: cfgFile,
      personaFile,
      memoryDir: dp.memoryDir,
      safetyLog: dp.safetyLog,
      safetyRules: path.join(pluginRoot, 'src', 'social', 'content-safety.mjs'),
      exportsDir: dp.exportsDir,
    }
  }

  /**
   * 仅允许打开白名单内的插件与数据路径（严禁接受任意原始路径，防止路径穿越）。
   */
  async function openLocalPath(key, filename = '') {
    const p = resolveKnownPaths()
    const allowlist = {
      plugin_root: { kind: 'dir', target: p.pluginRoot },
      behavior_dir: { kind: 'dir', target: p.behaviorDir },
      data_dir: { kind: 'dir', target: p.dataDir },
      config_file: { kind: 'file', target: p.configFile },
      persona_file: { kind: 'file', target: p.personaFile },
      memory_dir: { kind: 'dir', target: p.memoryDir },
      safety_log: { kind: 'file', target: p.safetyLog },
      safety_rules: { kind: 'file', target: p.safetyRules },
      exports_dir: { kind: 'dir', target: p.exportsDir },
    }
    let entry = allowlist[String(key || '')]
    if (key === 'exported_file') {
      const safeName = String(filename || '').trim()
      if (!EXPORT_FILENAME_RE.test(safeName)) {
        throw Error('导出文件名不合法，已拒绝打开。')
      }
      const baseDir = path.resolve(p.exportsDir)
      const resolved = path.resolve(baseDir, safeName)
      if (!resolved.startsWith(baseDir + path.sep)) {
        throw Error('导出文件路径越界，已拒绝打开。')
      }
      entry = { kind: 'file', target: resolved }
    }
    if (!entry) throw Error(`不支持打开的路径标识：${String(key || '(空)')}`)

    if (entry.kind === 'dir') {
      fs.mkdirSync(entry.target, { recursive: true })
      openPathImpl(entry.target, { selectFile: false })
      return { ok: true, key, openedPath: entry.target, mode: 'dir', exists: true }
    }
    if (fs.existsSync(entry.target)) {
      openPathImpl(entry.target, { selectFile: true })
      return { ok: true, key, openedPath: entry.target, mode: 'select', exists: true }
    }
    const parent = path.dirname(entry.target)
    fs.mkdirSync(parent, { recursive: true })
    openPathImpl(parent, { selectFile: false })
    return {
      ok: true,
      key,
      openedPath: parent,
      targetPath: entry.target,
      mode: 'parent_dir',
      exists: false,
      detail: '该文件尚未生成，已打开其所在目录。',
    }
  }

  async function getAbout() {
    return {
      ok: true,
      local: readLocalPluginMeta({ pluginRoot, whaleHome }),
      paths: resolveKnownPaths(),
    }
  }

  async function checkUpdate() {
    return checkForUpdate({ pluginRoot, whaleHome, fetchImpl: updateFetch })
  }

  async function applyUpdate(ref = 'main') {
    return applyPluginUpdate({
      pluginRoot,
      whaleHome,
      cfgFile,
      fetchImpl: updateFetch,
      ...(updateExtractZip ? { extractZip: updateExtractZip } : {}),
      ref,
    })
  }

  async function getModels({ forceRefresh = false } = {}) {
    const options = { timeoutMs: 12_000 }
    let viaIpc = await ipcClient(forceRefresh ? '/models?forceRefresh=1' : '/models', options)
    if (forceRefresh && !viaIpc?.running && /^(?:not found|HTTP 404)$/i.test(viaIpc?.error ?? '')) {
      viaIpc = await ipcClient('/models', options)
    }
    let sidecarCatalog = null
    if (viaIpc?.running && Array.isArray(viaIpc.groups)) {
      const withoutLegacyQuota = ({ remainingFraction, resetTime, ...item }) => item
      const models = (viaIpc.models ?? []).filter(model => model.groupKey !== 'auto-tier').map(withoutLegacyQuota)
      const groups = viaIpc.groups.filter(group => group.key !== 'auto-tier').map(group => ({
        ...withoutLegacyQuota(group),
        variants: (group.variants ?? []).map(withoutLegacyQuota),
      }))
      const source = groups.length && viaIpc.source !== 'fallback' ? 'live' : 'fallback'
      if (source === 'live' || viaIpc.usage) {
        sidecarCatalog = {
          ok: true, source, total: models.length, liveCount: models.length,
          groups, models, note: viaIpc.note || '',
          usage: viaIpc.usage ?? UNAVAILABLE_MODEL_USAGE,
          modelQuota: viaIpc.usage ? viaIpc.modelQuota ?? null : null,
        }
        // 优先接收后台守护已用于配额保护的同一次读取结果。
        if (viaIpc.usage) return sidecarCatalog
      }
    }
    if (rpc?.available?.()) {
      const direct = await rpc.getModelCatalog({ forceRefresh })
      if (direct?.source === 'live' || direct?.usage?.state === 'ready') return direct
    }
    return sidecarCatalog ?? fallbackModelCatalog('未能读取 Antigravity 实时模型清单，请确认后台守护已启动后点击刷新。')
  }

  function formatDepsCards(rawItems, scheduler, livePid = null) {
    const cards = []
    for (const it of rawItems || []) {
      const rawName = String(it.name || '')
      const detail = String(it.detail || '')
      // 跳过生物钟（已归类到「动态与记忆」）及独立数据目录（已归类到「关于与更新 → 目录路径与项目说明」）
      if (rawName.includes('生物钟') || rawName.includes('独立数据目录')) continue

      let key = 'other'
      let name = rawName
      let version = ''
      let location = ''
      let summary = detail
      let action = null
      let pause
      let status = it.ok ? 'ok' : 'error'

      if (rawName.startsWith('Node.js')) {
        key = 'node'
        name = 'Node.js 运行环境'
        version = detail.trim()
        summary = it.ok ? '满足插件脚本与后台守护最低版本要求（Node 24+）。' : '版本过低，请升级至 Node.js 24 LTS+。'
      } else if (rawName.startsWith('node 运行时')) {
        key = 'node-bin'
        location = detail.trim()
      } else if (rawName.startsWith('ffmpeg')) {
        key = 'ffmpeg'
        name = 'ffmpeg（视频抽帧组件）'
        if (!it.ok) status = 'optional'
        const [firstLine, secondLine] = detail.split('\n').map(s => s.trim())
        const verMatch = firstLine.match(/ffmpeg\s+version\s+([^\s]+)/i)
        const cleanVer = verMatch ? verMatch[1].replace(/-www\.[^-]+$/i, '') : firstLine.slice(0, 36)
        version = it.ok ? (cleanVer.startsWith('v') ? cleanVer : `v${cleanVer}`) : '未安装'
        location = (secondLine || '').replace(/^路径[：:]\s*/, '')
        summary = it.ok ? '支持视频关键帧抽取与画面理解。' : '视频抽帧必需组件：未安装时仅能读取字幕、弹幕与热评，无法查看视频画面（可运行 winget install Gyan.FFmpeg 安装）。'
      } else if (rawName.includes('cookie')) {
        key = 'bilibili'
        name = '大鲸鱼 B 站登录状态'
        if (it.paused) {
          version = '暂缓校验'
          status = 'paused'
        } else if (it.ok) {
          const m = detail.match(/已登录：(.+?)（mid (\d+)）/)
          version = m ? `${m[1]}（UID ${m[2]}）` : detail
          summary = '登录凭据校验有效，仅当前 Windows 用户可读。'
        } else {
          version = '尚未登录'
          summary = '尚未连接大鲸鱼 B 站账号，请前往【账号与主人】扫码登录。'
          action = 'goto_login'
        }
      } else if (rawName.includes('限流')) {
        key = 'rate'
        name = 'B 站接口限流保护'
        version = it.ok ? '正常' : '熔断冷却中'
      } else if (rawName.includes('请求保护')) {
        key = 'traffic'
        name = '全局防风控保护'
        pause = it.pause
        version = pause?.manual ? '等待人工处理' : pause?.cooldown ? '冷却中' : it.ok ? '正常' : '需核查'
        if (pause) summary = it.pendingDetail ?? ''
        if (pause?.cooldown && !pause.manual && !it.pendingDetail) status = 'paused'
      }

      cards.push({
        key,
        name,
        ok: Boolean(it.ok),
        status,
        version,
        location,
        detail: summary,
        fix: it.ok ? '' : (it.fix || ''),
        action,
        ...(pause && { pause }),
      })
    }

    const nodeCard = cards.find(c => c.key === 'node')
    const nodeBinCard = cards.find(c => c.key === 'node-bin')
    if (nodeCard && nodeBinCard) {
      nodeCard.location = nodeBinCard.location
      nodeCard.ok = nodeCard.ok && nodeBinCard.ok
      nodeCard.status = nodeCard.ok ? 'ok' : 'error'
      cards.splice(cards.indexOf(nodeBinCard), 1)
    }

    cards.push({
      key: 'sidecar',
      name: '后台守护（Sidecar）',
      ok: Boolean(scheduler?.ok),
      status: scheduler?.ok ? 'ok' : 'error',
      version: scheduler?.ok ? (livePid ? `运行中（PID ${livePid}）` : '运行中') : '未连接',
      location: '',
      detail: scheduler?.reason || '',
      fix: scheduler?.ok ? '' : '请确认插件已启用，或重启 Antigravity 后稍等几秒再检测。',
      action: null,
    })

    const ORDER = ['sidecar', 'node', 'ffmpeg', 'bilibili', 'rate', 'traffic']
    cards.sort((a, b) => {
      const ia = ORDER.indexOf(a.key)
      const ib = ORDER.indexOf(b.key)
      return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib)
    })
    return cards
  }

  function buildFallbackDepsCards(reason, scheduler, livePid = null) {
    const ff = (() => { try { return ffmpegInfo() } catch { return { ok: false, path: '', version: '' } } })()
    const [maj] = process.versions.node.split('.').map(Number)
    const nodeOk = maj >= 24
    const cred = credState()
    const ffVerMatch = String(ff.version || '').match(/ffmpeg\s+version\s+([^\s]+)/i)
    const ffCleanVer = ffVerMatch ? ffVerMatch[1].replace(/-www\.[^-]+$/i, '') : String(ff.version || '').slice(0, 36)
    const shortReason = String(reason || '部分环境项检测未完成，请稍后重试').replace(/\s+/g, ' ').trim().slice(0, 100)

    return [
      {
        key: 'sidecar',
        name: '后台守护（Sidecar）',
        ok: Boolean(scheduler?.ok),
        status: scheduler?.ok ? 'ok' : 'error',
        version: scheduler?.ok ? (livePid ? `运行中（PID ${livePid}）` : '运行中') : '未连接',
        location: '',
        detail: scheduler?.reason || '',
        fix: scheduler?.ok ? '' : '请确认插件已启用，或重启 Antigravity 后稍等几秒再检测。',
        action: null,
      },
      {
        key: 'node',
        name: 'Node.js 运行环境',
        ok: nodeOk,
        status: nodeOk ? 'ok' : 'error',
        version: `v${process.versions.node}`,
        location: process.execPath || '',
        detail: nodeOk ? '满足插件脚本与后台守护最低版本要求（Node 24+）。' : '版本过低，请升级至 Node.js 24 LTS+。',
        fix: '',
        action: null,
      },
      {
        key: 'ffmpeg',
        name: 'ffmpeg（视频抽帧组件）',
        ok: Boolean(ff.ok),
        status: ff.ok ? 'ok' : 'optional',
        version: ff.ok ? (ffCleanVer.startsWith('v') ? ffCleanVer : `v${ffCleanVer}`) : '未安装',
        location: ff.path || '',
        detail: ff.ok ? '支持视频关键帧抽取与画面理解。' : '视频抽帧必需组件：未安装时仅能读取字幕、弹幕与热评，无法查看视频画面（可运行 winget install Gyan.FFmpeg 安装）。',
        fix: '',
        action: null,
      },
      {
        key: 'bilibili',
        name: '大鲸鱼 B 站登录状态',
        ok: false,
        status: 'error',
        version: cred.present ? '待重新校验' : '尚未登录',
        location: '',
        detail: cred.present ? `本地存在登录凭据，但本次在线校验未完成（${shortReason}）。` : '尚未连接大鲸鱼 B 站账号，请前往【账号与主人】扫码登录。',
        fix: '',
        action: cred.present ? null : 'goto_login',
      },
      {
        key: 'rate',
        name: 'B 站接口限流保护',
        ok: false,
        status: 'error',
        version: '检测未完成',
        location: '',
        detail: `未能完成本次环境子进程检测（${shortReason}），请点击【重新检测】。`,
        fix: '',
        action: null,
      },
      {
        key: 'traffic',
        name: '全局防风控保护',
        ok: false,
        status: 'error',
        version: '检测未完成',
        location: '',
        detail: '请点击【重新检测】或导出诊断日志排查。',
        fix: '',
        action: null,
      },
    ]
  }

  function parseDepsJson(rawStdout) {
    const txt = String(rawStdout || '').trim()
    if (!txt) throw new Error('空输出')
    try { return JSON.parse(txt) } catch {}
    const start = txt.indexOf('{')
    const end = txt.lastIndexOf('}')
    if (start >= 0 && end > start) {
      return JSON.parse(txt.slice(start, end + 1))
    }
    throw new Error('非 JSON 输出')
  }

  async function checkDeps() {
    const live = await ipcClient('/status')
    const scheduler = live.running
      ? (live.schedulerStatus ?? { ok: true, reason: `后台守护运行中（PID ${live.pid}）。` })
      : { ok: false, reason: '后台守护未连接，请确认 Antigravity 已启动插件 Sidecar。' }
    const livePid = live.running ? live.pid : null

    if (!fs.existsSync(biliMjs)) {
      const cards = buildFallbackDepsCards('插件核心脚本缺失', scheduler, livePid)
      return { ok: false, checkedAt: new Date().toISOString(), items: [], cards, scheduler, dataDir: whaleHome }
    }
    let probedCredentials
    try { probedCredentials = fs.readFileSync(credFile, 'utf8') } catch {}
    const r = await execNode([biliMjs, 'deps', '--json'], { timeout: 60_000 })
    try {
      const parsed = parseDepsJson(r.stdout)
      if (!Array.isArray(parsed?.items)) throw new Error('缺少检测项')
      let selfNow = null
      try {
        const ck = (parsed.items ?? []).find(it => it.name === 'B站 cookie')
        const m = ck?.ok === true && String(ck.detail ?? '').match(/^已登录：(.+?)（mid (\d+)）$/)
        if (m && probedCredentials && fs.readFileSync(credFile, 'utf8') === probedCredentials) {
          const account = { mid: m[2], name: m[1] }
          const cur = readConfig()
          if (String(cur.self?.mid ?? '') !== account.mid || String(cur.self?.name ?? '') !== account.name) {
            writeConfig({ ...cur, self: account })
          }
          selfNow = account
        }
      } catch {}
      const cards = formatDepsCards(parsed.items ?? [], scheduler, livePid)
      const allRequiredOk = cards.every(c => c.ok || c.status === 'optional')
      return {
        ok: allRequiredOk,
        checkedAt: new Date().toISOString(),
        items: parsed.items ?? [],
        cards,
        node: parsed.node,
        self: selfNow,
        scheduler,
        dataDir: whaleHome,
      }
    } catch {
      const reason = r.err?.killed ? '检测超时' : (r.err?.code === 'ENOENT' ? '未找到 Node.js 运行时' : '子进程返回异常')
      const cards = buildFallbackDepsCards(reason, scheduler, livePid)
      return {
        ok: false,
        checkedAt: new Date().toISOString(),
        items: [],
        cards,
        scheduler,
        dataDir: whaleHome,
      }
    }
  }

  function identitySummary(cfg) {
    const accountMid = String(cfg?.self?.mid ?? '').trim()
    const ownerMid = String(cfg?.owner?.mid ?? '').trim()
    return {
      accountMid,
      ownerMid,
      hasAccount: Boolean(accountMid),
      hasOwner: Boolean(ownerMid),
      ready: Boolean(accountMid && ownerMid),
    }
  }

  function assertIdentityReadyForAction(cfg, actionLabel) {
    const id = identitySummary(cfg)
    if (id.ready) return id
    if (!id.hasAccount && !id.hasOwner) {
      throw Error(`请先在【账号与主人】完成 B 站扫码登录并填写主人 UID，保存后再${actionLabel}。`)
    }
    if (!id.hasAccount) {
      throw Error(`尚未登录大鲸鱼 B 站账号，请先在【账号与主人】扫码登录后再${actionLabel}。`)
    }
    throw Error(`尚未配置主人 UID，请先在【账号与主人】填写并保存主人信息后再${actionLabel}。`)
  }

  async function getStatus() {
    const dp = dataPathsFor(whaleHome, { cfgFile })
    const readJson = p => { try { return JSON.parse(fs.readFileSync(p, 'utf8')) } catch { return null } }
    const cfg = readConfig()
    const cred = credState()
    const identity = {
      ...identitySummary(cfg),
      credentialsPresent: Boolean(cred.hasSess && cred.hasJct),
    }
    const quota = readJson(dp.quota) ?? { log: [] }
    const today = new Date().toLocaleDateString('sv-SE')
    const todays = (quota.log ?? []).filter(x => new Date(x.at).toLocaleDateString('sv-SE') === today)
    const night = readJson(dp.schedule)
    const live = await ipcClient('/status')
    const store = lifeStore(cfg, { whaleHome })
    const safetyBlocks = readRecentSafetyBlocks(whaleHome, 10)
    const calendar = buildActivityCalendar({ whaleHome, cfg, store })
    return {
      ok: true,
      today,
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      dataDir: whaleHome,
      identity,
      sidecarRunning: !!live.running,
      sidecarPid: live.pid ?? null,
      shares: todays.filter(x => x.share).length,
      sharesMax: cfg.quota?.shareDaily ?? 3,
      dynamicDailyMax: chatConfig(cfg.chat).dynamicDailyMax,
      autoCommentDailyMax: chatConfig(cfg.chat).autoCommentDailyMax,
      commentsToday: todays.length,
      fanQuota: readFanQuotaSummary(whaleHome),
      safetyBlockedCount: safetyBlocks.length,
      calendar,
      delivery: deliveryStatus(whaleHome),
      scheduler: readSchedulerHealth(whaleHome),
      affect: store.affectStatus(),
      affectWorker: live.affectWorker ?? { status: live.running ? 'idle' : 'unavailable' },
      formation: live.formationWorker ?? { status: live.running ? 'idle' : 'unavailable' },
      safetyWorker: live.safetyWorker ?? { status: live.running ? 'idle' : 'unavailable' },
      modelQuota: live.modelQuota?.checkedAt ? live.modelQuota : {
        enabled: (cfg.models?.minQuotaPercent ?? 0) > 0,
        paused: false,
        threshold: cfg.models?.minQuotaPercent ?? 0,
        remainingPercent: null,
      },
      plan: night ? { date: night.date, action: night.action, atText: night.atText ?? null, wakes: Number(night.wakes ?? 0), windows: night.usedWindows ?? [] } : null,
    }
  }

  /**
   * 导出带时间戳的脱敏诊断日志（绝不含 Cookie / SESSDATA / Token 等凭据）。
   */
  async function exportDiagnostics() {
    const now = new Date()
    const [deps, status] = await Promise.all([checkDeps(), getStatus()])
    const cfg = readConfig()
    const localMeta = readLocalPluginMeta({ pluginRoot, whaleHome })
    const recentBlocks = readRecentSafetyBlocks(whaleHome, 30).map(({ at, channel, layer }) => ({ at, channel, layer }))
    const filename = `antigravity-bili-whale-diag-${fileTimestamp(now)}.json`
    const payload = {
      exportedAt: now.toISOString(),
      plugin: {
        name: localMeta.name,
        version: localMeta.version,
        installedCommit: localMeta.installedCommit,
      },
      platform: {
        os: process.platform,
        arch: process.arch,
        node: process.version,
      },
      credentialsPresent: credState(),
      environmentChecks: {
        ok: deps.ok, checkedAt: deps.checkedAt,
        cards: deps.cards.map(({ key, ok, status }) => ({ key, ok, status })),
      },
      runtimeStatus: {
        today: status.today, timezone: status.timezone, sidecarRunning: status.sidecarRunning,
        shares: status.shares, commentsToday: status.commentsToday, safetyBlockedCount: status.safetyBlockedCount,
        calendar: {
          activeDays: status.calendar.activeDays,
          incomplete: status.calendar.incomplete,
          errorCodes: [...new Set((status.calendar.diagnostics ?? []).map(issue => issue.code))],
          totals: status.calendar.totals,
          days: Object.fromEntries(Object.entries(status.calendar.days).map(([day, bucket]) => [day, bucket.total])),
        },
        delivery: { unconfirmed: status.delivery.unconfirmed, consecutiveFailures: status.delivery.consecutiveFailures },
        scheduler: { status: status.scheduler?.status, lastTickAt: status.scheduler?.lastTickAt, errorCode: status.scheduler?.lastError?.code },
        affectWorker: { status: status.affectWorker.status, code: status.affectWorker.code },
        formation: { status: status.formation.status, code: status.formation.code },
        safetyWorker: { status: status.safetyWorker.status, checkedCount: status.safetyWorker.checkedCount, blockedCount: status.safetyWorker.blockedCount },
        modelQuota: { enabled: status.modelQuota.enabled, paused: status.modelQuota.paused, threshold: status.modelQuota.threshold, remainingPercent: status.modelQuota.remainingPercent },
      },
      recentSafetyBlocks: recentBlocks,
      configSummary: {
        browse: cfg.browse,
        models: cfg.models,
        watch: cfg.watch,
        share: { enabled: cfg.share?.enabled, via: cfg.share?.via },
        listen: cfg.listen,
        fanLimits: cfg.fanLimits,
        safety: { enabled: cfg.safety?.enabled, mode: cfg.safety?.mode, scope: cfg.safety?.scope, customWordsCount: cfg.safety?.customWords?.length ?? 0 },
        night: { windowCount: cfg.night?.windows?.length ?? 0, skipChance: cfg.night?.skipChance, minGapMin: cfg.night?.minGapMin },
        sessionRotateDays: cfg.sessionRotateDays,
      },
    }
    const exportsDir = path.join(whaleHome, 'exports')
    const filePath = path.join(exportsDir, filename)
    fs.mkdirSync(exportsDir, { recursive: true })
    const serialized = JSON.stringify(payload, null, 2) + '\n'
    fs.writeFileSync(filePath, serialized, 'utf8')
    return {
      ok: true,
      filename,
      filePath,
      dirPath: exportsDir,
      bytes: Buffer.byteLength(serialized, 'utf8'),
      exportedAt: now.toISOString(),
      payload,
    }
  }

  async function lifeAction(action, b = {}) {
    const cfg = readConfig()
    const identity = identitySummary(cfg)
    const store = lifeStore(cfg, { whaleHome })
    const live = await ipcClient('/status')
    const statusWithMeta = () => ({
      ...store.status(),
      identity,
    })
    if (!action || action === 'status') {
      return {
        ok: true,
        state: {
          ...statusWithMeta(),
          affectWorker: live.affectWorker ?? { status: 'unavailable' },
          formationWorker: live.formationWorker ?? { status: 'unavailable', reason: '后台守护未运行' },
        },
      }
    }
    let result
    switch (action) {
      case 'pause':
        assertIdentityReadyForAction(cfg, '控制主动活动')
        result = await store.pause(b.value === true)
        await ipcClient('/invalidate', { method: 'POST', body: { resetPlan: false } }).catch(() => {})
        break
      case 'export': {
        result = store.export()
        const now = new Date()
        const exportsDir = path.join(whaleHome, 'exports')
        const filename = `antigravity-whale-memory-${fileTimestamp(now)}.json`
        const filePath = path.join(exportsDir, filename)
        fs.mkdirSync(exportsDir, { recursive: true })
        const serialized = JSON.stringify(result, null, 2) + '\n'
        fs.writeFileSync(filePath, serialized, 'utf8')
        return {
          ok: true,
          filename,
          filePath,
          dirPath: exportsDir,
          bytes: Buffer.byteLength(serialized, 'utf8'),
          exportedAt: now.toISOString(),
          result,
          state: statusWithMeta(),
        }
      }
      case 'search': {
        const limit = Math.min(100, Math.max(1, Math.floor(Number(b.limit) || 20)))
        result = store.search(String(b.query ?? ''), { archives: true, limit })
        return { ok: true, result, limit, state: statusWithMeta() }
      }
      case 'resolve':
        if (b.confirmed !== true) throw Error('请先到 B 站核查并确认发送结果。')
        assertIdentityReadyForAction(cfg, '结案未确认发送')
        result = await store.settle(String(b.id), { status: b.status, receipt: b.receipt, verified: true })
        break
      default: throw Error('未知的记忆管理操作：' + action)
    }
    return { ok: true, result, state: statusWithMeta() }
  }

  async function wakeNow() {
    const res = await ipcClient('/wake-now', { method: 'POST', body: {}, timeoutMs: 70_000 })
    if (!res?.running) {
      throw Error(res?.error || '后台守护未运行，请确认插件已启用或重启 Antigravity 后再试。')
    }
    if (res.ok === false) {
      throw Error(res.error || '立即唤醒失败。')
    }
    return {
      ok: true,
      atText: res.atText || '',
      requestId: res.requestId || '',
      detail: res.detail || '已立即唤醒大鲸鱼，正在后台自主浏览并观看视频。',
    }
  }

  return {
    getSettings,
    saveSettings,
    getPersona,
    savePersona,
    qrStart,
    qrPoll: (id) => qrAuth.poll(String(id ?? '')),
    qrCancel: (id) => qrAuth.cancel(String(id ?? '')),
    logout,
    verifyOwner,
    openLocalPath,
    wakeNow,
    getAbout,
    checkUpdate,
    applyUpdate,
    getModels,
    checkDeps,
    getStatus,
    exportDiagnostics,
    lifeAction,
    dispose: () => qrAuth.dispose(),
  }
}
