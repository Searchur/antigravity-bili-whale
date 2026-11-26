import fs from 'node:fs'
import path from 'node:path'
import { execFile } from 'node:child_process'
import {
  PLUGIN_ROOT,
  WHALE_HOME,
  configPath,
  credentialsPath,
  personaPath,
  pendingRepliesPath,
  whalePath,
} from '../tools/lib/paths.mjs'
import { DEFAULTS, LISTEN_DEFAULTS, MODEL_DEFAULTS, WATCH_DEFAULTS, MAX_LIKE_TAGS, MAX_DISLIKE_TAGS, MAX_PERSONA_CHARS, normalizeModels, normalizeWatch, withoutRetiredListening } from '../tools/lib/config.mjs'
import { CHAT_DEFAULTS, chatConfig } from '../tools/lib/chat-config.mjs'
import { LIFE_DEFAULTS, lifeConfig } from '../tools/lib/life-config.mjs'
import { windowIssues } from '../tools/lib/night-plan.mjs'
import { lifeStore } from '../tools/lib/life-runtime.mjs'
import { corpusFor } from '../tools/lib/corpus-runtime.mjs'
import { diagnose } from '../tools/lib/diagnostics.mjs'
import { RISK_DEFAULTS } from '../tools/lib/traffic.mjs'
import { installFfmpeg } from '../tools/lib/ffmpeg.mjs'
import { createCredentialStore } from './credentials.js'
import { QrAuth, verifyAccount } from './auth.js'
import { deliveryStatus } from './delivery-state.js'
import { readSchedulerHealth } from './scheduler-health.js'
import { resolveNodeRuntime, nodeEnv } from './node-runtime.js'
import { callSidecarIpc } from './sidecar-ipc.js'
import { createAntigravityRpc, fallbackModelCatalog } from './antigravity-rpc.js'
import { readLocalPluginMeta, checkForUpdate, applyPluginUpdate } from './plugin-updater.js'

const BASE_DEFAULTS = {
  ...DEFAULTS,
  chat: CHAT_DEFAULTS,
  life: LIFE_DEFAULTS,
  models: { ...MODEL_DEFAULTS },
  watch: {
    auto: { ...WATCH_DEFAULTS.auto },
    mention: { ...WATCH_DEFAULTS.mention },
  },
  risk: RISK_DEFAULTS,
  listen: { ...LISTEN_DEFAULTS },
}

const KNOWN_TOP_KEYS = new Set([
  'persona', 'preferences', 'notify', 'aliases', 'owner', 'self', 'quota', 'share',
  'listen', 'diary', 'night', 'home', 'risk', 'sessionRotateDays', 'personaOncePerSession',
  'life', 'chat', 'models', 'watch',
])

const merge = (base, over) => {
  const out = { ...base }
  for (const [k, v] of Object.entries(over || {})) {
    out[k] = v && typeof v === 'object' && !Array.isArray(v) ? merge(base[k] ?? {}, v) : v
  }
  return out
}

/**
 * 与宿主完全解耦的管理面板业务 API 层（供 MCP App 专用工具调用，亦可独立单测）。
 */
export function createApiHandlers({
  pluginRoot = PLUGIN_ROOT,
  whaleHome = WHALE_HOME,
  cfgFile = configPath,
  credFile = credentialsPath,
  personaFile = personaPath,
  pendingFile = pendingRepliesPath,
  biliMjs = path.join(PLUGIN_ROOT, 'tools', 'bili.mjs'),
  ipcClient = callSidecarIpc,
  rpc = createAntigravityRpc(),
  verify = verifyAccount,
  qrFetch = globalThis.fetch,
  updateFetch = globalThis.fetch,
  updateExtractZip,
  ffmpegInstaller = installFfmpeg,
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
        throw Error('配置文件损坏或不可读取，未使用默认值覆盖')
      }
    }
    const merged = withoutRetiredListening({ ...merge(BASE_DEFAULTS, user), __hasUserFile: Object.keys(user).length > 0 })
    merged.models = normalizeModels(merged.models)
    merged.watch = normalizeWatch(merged.watch)
    if (!String(merged.persona?.name ?? '').trim()) {
      merged.persona = { ...(merged.persona ?? {}), name: '大鲸鱼' }
    }
    return merged
  }

  function writeConfig(next) {
    const clean = withoutRetiredListening({ ...next })
    delete clean.__hasUserFile
    clean.models = normalizeModels(clean.models)
    clean.watch = normalizeWatch(clean.watch)
    if (!String(clean.persona?.name ?? '').trim()) {
      clean.persona = { ...(clean.persona ?? {}), name: '大鲸鱼' }
    }
    fs.mkdirSync(path.dirname(cfgFile), { recursive: true })
    const temp = `${cfgFile}.${process.pid}.tmp`
    try {
      fs.writeFileSync(temp, JSON.stringify(clean, null, 2) + '\n', { mode: 0o600 })
      fs.renameSync(temp, cfgFile)
    } finally {
      fs.rmSync(temp, { force: true })
    }
  }

  function credState() {
    try {
      const c = JSON.parse(fs.readFileSync(credFile, 'utf8'))
      return { present: true, hasSess: !!c.sessdata, hasJct: !!c.bili_jct, hasBuvid: !!c.buvid3 }
    } catch {
      return { present: false, hasSess: false, hasJct: false, hasBuvid: false }
    }
  }

  const credentialStore = createCredentialStore({ file: credFile, pending: pendingFile, verify })

  const saveLogin = async (credentials, options) => {
    const account = await credentialStore.save(credentials, options)
    try {
      const current = readConfig()
      writeConfig({ ...current, self: account })
      await ipcClient('/invalidate', { method: 'POST', body: { resetPlan: false } })
    } catch {
      return { ...account, warn: '登录态已保存，但账号显示信息未更新；请重新读取配置。' }
    }
    return account
  }

  const qrAuth = new QrAuth({ save: saveLogin, fetch: qrFetch })

  async function getSettings() {
    return { ok: true, config: readConfig(), credentials: credState(), configPath: cfgFile, dataDir: whaleHome }
  }

  async function saveSettings(incomingRaw) {
    const cur = readConfig()
    const incoming = (incomingRaw && typeof incomingRaw.config === 'object' && incomingRaw.config) || incomingRaw || {}
    const filtered = {}
    for (const [k, v] of Object.entries(incoming)) {
      if (KNOWN_TOP_KEYS.has(k)) filtered[k] = v
    }
    const next = merge(cur, filtered)
    const rotateDays = Number(next.sessionRotateDays)
    if (!Number.isFinite(rotateDays) || rotateDays < 0 || rotateDays > 365 || typeof next.personaOncePerSession !== 'boolean') {
      throw Error('会话轮换天数须为 0–365；人设去重须为布尔值')
    }
    next.sessionRotateDays = rotateDays
    const n = next.night
    if (!Array.isArray(n.windows) || !n.windows.length) throw Error('至少要有一个作息窗口')
    const windowProblems = windowIssues({ windows: n.windows })
    if (windowProblems.length && n.windows.every(w => !w || typeof w !== 'object' || !String(w.start ?? '').trim() || !String(w.end ?? '').trim())) {
      throw Error(windowProblems[0].message)
    }
    const totalWakes = Math.max(1, n.windows.reduce((sum, w) => sum + (Number(w?.wakes) || 1), 0))
    n.maxWakesPerDay = Math.min(12, Math.max(0, Number(n.maxWakesPerDay ?? totalWakes) || totalWakes))
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
      throw Error(`喜欢的类型最多设置 ${MAX_LIKE_TAGS} 个（每次醒来最多按前 ${MAX_LIKE_TAGS} 个主题搜索，过多容易触发 B 站限流）`)
    }
    if (dislikeTags.length > MAX_DISLIKE_TAGS) {
      throw Error(`不喜欢的类型最多设置 ${MAX_DISLIKE_TAGS} 个`)
    }
    next.preferences = { ...(next.preferences ?? {}), like: likeTags, dislike: dislikeTags }
    const sd = Number(next.quota?.shareDaily)
    next.quota = { ...(next.quota ?? {}), shareDaily: Number.isFinite(sd) ? Math.min(20, Math.max(0, sd)) : 3 }
    next.life = lifeConfig(next.life)
    next.chat = chatConfig(next.chat)
    next.models = normalizeModels(next.models)
    next.watch = normalizeWatch(next.watch)
    if (!String(next.persona?.name ?? '').trim()) {
      next.persona = { ...(next.persona ?? {}), name: '大鲸鱼' }
    }

    if (cur.self?.mid && cur.owner?.mid && (
      ['enabled', 'learningEnabled', 'paused'].some(k => lifeConfig(cur.life)[k] !== next.life[k])
      || ['enabled', 'shadow'].some(k => lifeConfig(cur.life).dynamicMemory[k] !== next.life.dynamicMemory[k])
    )) {
      await lifeStore(cur, { dshHome: whaleHome }).invalidateFormation()
    }
    writeConfig(next)

    const schedulingChanged = ['windows', 'skipChance', 'maxVideos', 'deepWatchMax', 'minGapMin'].some(
      key => JSON.stringify(cur.night?.[key]) !== JSON.stringify(next.night?.[key]),
    )
    const ipc = await ipcClient('/invalidate', { method: 'POST', body: { resetPlan: schedulingChanged } })
    const reloadWarning = ipc.running ? null : '设置已保存，但后台守护尚未运行（将在后台守护启动时自动加载）'
    const quotaWarning = next.quota.shareDaily > 3 ? '分享条数 >3：容易触发 B 站限流/风控' : null
    return { ok: true, config: readConfig(), configPath: cfgFile, warn: reloadWarning ?? quotaWarning }
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
    if (text.length > MAX_PERSONA_CHARS) throw Error(`人设正文太长（硬上限 ${MAX_PERSONA_CHARS} 字，当前 ${text.length} 字），精简后再保存效果更稳`)
    fs.mkdirSync(path.dirname(personaFile), { recursive: true })
    fs.writeFileSync(personaFile, text, 'utf8')
    const bytes = Buffer.byteLength(text, 'utf8')
    return {
      ok: true,
      bytes,
      maxChars: MAX_PERSONA_CHARS,
      detail: text.trim()
        ? `✓ 已保存（${text.length} 字 / ${bytes} 字节）—— 从下一次唤醒开始生效`
        : '✓ 已清空 —— 回到仅使用设置里的基础称呼',
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
      throw Error(`核验失败：${msg}（code=${json?.code ?? 'unknown'}）`)
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
        detail: `已查到 UID ${mid} 对应的 B 站昵称为「${actualName}」，可点击一键填入。`,
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
        ? `✓ 核验通过：UID ${mid} 与昵称「${actualName}」完全对应`
        : `⚠ 不一致：UID ${mid} 在 B 站的实际昵称是「${actualName}」，与当前填写的「${expectedName}」不同`,
    }
  }

  async function getAbout() {
    return { ok: true, local: readLocalPluginMeta({ pluginRoot, whaleHome }) }
  }

  async function checkUpdate() {
    return checkForUpdate({ pluginRoot, whaleHome, fetchImpl: updateFetch })
  }

  async function applyUpdate(ref = 'main') {
    return applyPluginUpdate({
      pluginRoot,
      whaleHome,
      fetchImpl: updateFetch,
      ...(updateExtractZip ? { extractZip: updateExtractZip } : {}),
      ref,
    })
  }

  async function getModels() {
    if (rpc?.available?.()) {
      const cat = await rpc.getModelCatalog()
      if (cat?.source === 'live') return cat
    }
    const viaIpc = await ipcClient('/models', { timeoutMs: 8_000 })
    if (viaIpc?.running && Array.isArray(viaIpc.groups)) {
      return {
        ok: true,
        source: viaIpc.source || 'live',
        total: viaIpc.total ?? viaIpc.models?.length ?? 0,
        liveCount: viaIpc.liveCount ?? 0,
        groups: viaIpc.groups,
        models: viaIpc.models ?? [],
        note: viaIpc.note || '',
      }
    }
    return fallbackModelCatalog('未能读取 Antigravity 实时模型清单，请确认后台守护已启动后点击刷新')
  }

  function formatDepsCards(rawItems, scheduler, livePid = null) {
    const cards = []
    for (const it of rawItems || []) {
      const rawName = String(it.name || '')
      const detail = String(it.detail || '')
      let key = 'other'
      let name = rawName
      let optional = false
      let version = ''
      let location = ''
      let summary = detail
      let action = null

      if (rawName.startsWith('Node.js')) {
        key = 'node'
        name = 'Node.js 运行环境'
        version = detail.trim()
        summary = it.ok ? '满足插件脚本与后台守护最低版本要求（22.13+）' : '版本过低，请升级至 Node.js 22.13+ 或 24 LTS'
      } else if (rawName.startsWith('node 运行时')) {
        key = 'node-bin'
        location = detail.trim()
      } else if (rawName.startsWith('ffmpeg')) {
        key = 'ffmpeg'
        name = 'ffmpeg（视频抽帧看画面）'
        optional = true
        const [firstLine, secondLine] = detail.split('\n').map(s => s.trim())
        const verMatch = firstLine.match(/ffmpeg\s+version\s+([^\s]+)/i)
        const cleanVer = verMatch ? verMatch[1].replace(/-www\.[^-]+$/i, '') : firstLine.slice(0, 36)
        version = it.ok ? (cleanVer.startsWith('v') ? cleanVer : `v${cleanVer}`) : '未安装'
        location = (secondLine || '').replace(/^路径[：:]\s*/, '')
        summary = it.ok ? '支持视频关键帧抽取与画面理解' : '可选组件：不安装也能正常纯文字浏览，安装后可看视频画面'
        if (!it.ok) action = 'install_ffmpeg'
      } else if (rawName.includes('cookie')) {
        key = 'bilibili'
        name = '大鲸鱼 B 站账号'
        const m = detail.match(/已登录：(.+?)（mid (\d+)）/)
        version = it.ok ? (m ? `${m[1]}（UID ${m[2]}）` : detail) : '尚未登录'
        summary = it.ok ? '登录凭据校验有效，仅当前 Windows 用户可读' : '尚未连接大鲸鱼的 B 站账号，请前往扫码登录'
        if (!it.ok) action = 'goto_login'
      } else if (rawName.includes('独立数据目录')) {
        key = 'datadir'
        name = '独立数据目录'
        version = it.ok ? '可读写' : '权限异常'
        location = detail.trim()
        summary = '所有记忆、日记与凭据完全隔离在此目录'
      } else if (rawName.includes('生物钟')) {
        key = 'scheduler'
        name = '生物钟作息计划'
        version = it.ok ? '运行正常' : '待启动 / 需检查'
      } else if (rawName.includes('限流')) {
        key = 'rate'
        name = 'B 站接口限流保护'
        version = it.ok ? '正常' : '熔断冷却中'
      } else if (rawName.includes('请求保护')) {
        key = 'traffic'
        name = '全局防风控保护'
        version = it.ok ? '正常' : '需核查'
      }

      cards.push({
        key,
        name,
        ok: Boolean(it.ok),
        status: it.ok ? 'ok' : optional ? 'optional' : 'error',
        version,
        location,
        detail: summary,
        fix: it.ok ? '' : (it.fix || ''),
        action,
      })
    }

    // 合并 Node.js 版本与可执行路径到同一张卡片
    const nodeCard = cards.find(c => c.key === 'node')
    const nodeBinCard = cards.find(c => c.key === 'node-bin')
    if (nodeCard && nodeBinCard) {
      nodeCard.location = nodeBinCard.location
      nodeCard.ok = nodeCard.ok && nodeBinCard.ok
      nodeCard.status = nodeCard.ok ? 'ok' : 'error'
      cards.splice(cards.indexOf(nodeBinCard), 1)
    }

    // 补充后台守护实时 IPC 卡片
    cards.push({
      key: 'sidecar',
      name: '后台守护进程（Sidecar）',
      ok: Boolean(scheduler?.ok),
      status: scheduler?.ok ? 'ok' : 'error',
      version: scheduler?.ok ? (livePid ? `在线运行 · PID ${livePid}` : '在线运行') : '未连接',
      location: '',
      detail: scheduler?.reason || '',
      fix: scheduler?.ok ? '' : '请确认插件已启用，或重启 Antigravity App 后稍等几秒再刷新。',
      action: null,
    })

    const ORDER = ['node', 'ffmpeg', 'bilibili', 'sidecar', 'datadir', 'scheduler', 'rate', 'traffic']
    cards.sort((a, b) => {
      const ia = ORDER.indexOf(a.key)
      const ib = ORDER.indexOf(b.key)
      return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib)
    })
    return cards
  }

  async function checkDeps() {
    if (!fs.existsSync(biliMjs)) return { ok: false, error: `找不到 bili.mjs：${biliMjs}`, items: [], cards: [] }
    const [r, live] = await Promise.all([
      execNode([biliMjs, 'deps', '--json'], { timeout: 60_000 }),
      ipcClient('/status'),
    ])
    try {
      const parsed = JSON.parse(r.stdout || '{}')
      let selfNow = null
      try {
        const ck = (parsed.items ?? []).find(it => it.name === 'B站 cookie')
        const m = String(ck?.detail ?? '').match(/已登录：(.+?)（mid (\d+)）/)
        if (m) {
          selfNow = { name: m[1], mid: m[2] }
          const cur = readConfig()
          if (String(cur.self?.mid ?? '') !== selfNow.mid || String(cur.self?.name ?? '') !== selfNow.name) {
            writeConfig({ ...cur, self: selfNow })
          }
        }
      } catch {}
      const scheduler = live.running
        ? (live.schedulerStatus ?? { ok: true, reason: `后台守护运行中（PID ${live.pid}）` })
        : { ok: false, reason: '后台守护未连接（请确认 Antigravity 已启动插件 Sidecar）' }
      const cards = formatDepsCards(parsed.items ?? [], scheduler, live.running ? live.pid : null)
      const allRequiredOk = cards.every(c => c.status !== 'error')
      return {
        ok: allRequiredOk,
        items: parsed.items ?? [],
        cards,
        node: parsed.node,
        self: selfNow,
        scheduler,
        dataDir: whaleHome,
      }
    } catch {
      return { ok: false, error: String(r.stderr || r.err?.message || 'deps 运行失败').slice(0, 300), items: [], cards: [] }
    }
  }

  async function getPending() {
    let items = []
    try { items = JSON.parse(fs.readFileSync(pendingFile, 'utf8')).items ?? [] } catch {}
    return { ok: true, items }
  }

  async function rejectPending(id, reason = '') {
    if (!id) throw Error('需要草稿 id')
    const r = await execNode([biliMjs, 'reply-draft', 'drop', String(id)], { timeout: 20_000 })
    if (r.ok) {
      try {
        fs.mkdirSync(whaleHome, { recursive: true })
        fs.appendFileSync(path.join(whaleHome, 'whale-log.jsonl'),
          JSON.stringify({ at: new Date().toISOString(), kind: 'reply-rejected', target: null, note: `主人否掉了草稿 ${id}${reason ? '：' + String(reason).slice(0, 80) : ''}` }) + '\n')
      } catch {}
    }
    return { ok: r.ok, out: r.stdout.slice(0, 300) }
  }

  async function approvePending(id) {
    if (!id) throw Error('需要草稿 id')
    const cfgNow = readConfig()
    const taken = await execNode([biliMjs, 'reply-draft', 'take', String(id)], { timeout: 20_000 })
    let item = null
    try { item = JSON.parse(taken.stdout || '') } catch {}
    if (!item) throw Error('队列里没有这条（可能已经发过）')

    const args = ['comment', '--oid', item.oid, '--root', item.root, '--parent', item.parent,
      '--message', item.message, '--auto', ...(cfgNow.listen?.oncePerPerson !== false ? ['--once-per-person'] : []), '--go']
    if (item.bvid) args.push('--bvid', item.bvid)
    const sent = await execNode([biliMjs, ...args], { timeout: 360_000 })
    const ok = sent.ok && /code=0/.test(sent.stdout)
    const rpid = (sent.stdout.match(/rpid=(\d+)/) ?? [])[1] ?? null
    try {
      fs.mkdirSync(whaleHome, { recursive: true })
      fs.appendFileSync(path.join(whaleHome, 'whale-log.jsonl'),
        JSON.stringify({ at: new Date().toISOString(), kind: ok ? 'reply-sent' : 'reply-failed', target: item.who || item.parent, note: `${ok ? '主人批准并发出' : '发送失败'} · ${String(item.message).slice(0, 60)}` }) + '\n')
    } catch {}
    if (!ok) {
      const back = ['reply-draft', 'add', '--oid', item.oid, '--message', item.message]
      if (item.bvid) back.push('--bvid', item.bvid)
      if (item.root) back.push('--root', item.root)
      if (item.parent) back.push('--parent', item.parent)
      if (item.who) back.push('--who', item.who)
      if (item.src) back.push('--src', item.src)
      await execNode([biliMjs, ...back], { timeout: 20_000 })
    }
    return { ok, rpid, out: sent.stdout.slice(-600), err: sent.stderr.slice(0, 400) }
  }

  async function notifyTest() {
    const cfg = readConfig()
    const notifyMjs = path.join(path.dirname(biliMjs), 'commands', 'notify.mjs')
    if (!fs.existsSync(notifyMjs)) return { ok: false, error: `找不到 notify.mjs：${notifyMjs}` }
    const r = await execNode([notifyMjs, '--test'], { timeout: 120_000 })
    return { ok: r.ok, out: r.stdout.slice(0, 800), err: r.stderr.slice(0, 800), type: cfg.notify?.type ?? 'none' }
  }

  async function getStatus() {
    const readJson = p => { try { return JSON.parse(fs.readFileSync(p, 'utf8')) } catch { return null } }
    const cfg = readConfig()
    const quota = readJson(path.join(whaleHome, 'quota.json')) ?? { log: [] }
    const today = new Date().toLocaleDateString('sv-SE')
    const todays = (quota.log ?? []).filter(x => new Date(x.at).toLocaleDateString('sv-SE') === today)
    const night = readJson(path.join(whaleHome, 'whale-night.json'))
    const replied = readJson(path.join(whaleHome, 'replied.json'))
    const live = await ipcClient('/status')
    const store = lifeStore(cfg, { dshHome: whaleHome })
    return {
      ok: true,
      today,
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      dataDir: whaleHome,
      sidecarRunning: !!live.running,
      sidecarPid: live.pid ?? null,
      shares: todays.filter(x => x.share).length,
      sharesMax: cfg.quota?.shareDaily ?? 3,
      commentsToday: todays.length,
      repliedPeople: Object.keys(replied?.byUid ?? {}).length,
      delivery: deliveryStatus(whaleHome),
      scheduler: readSchedulerHealth(whaleHome),
      affect: store.affectStatus(),
      affectWorker: live.affectWorker ?? { status: live.running ? 'idle' : 'unavailable' },
      diary: store.diaryStatus(),
      diaryWorker: live.diaryWorker ?? { status: live.running ? 'idle' : 'unavailable' },
      socialWorker: live.socialWorker ?? { status: live.running ? 'idle' : 'unavailable' },
      formation: live.formationWorker ?? { status: live.running ? 'idle' : 'unavailable' },
      plan: night ? { date: night.date, action: night.action, atText: night.atText ?? null, wakes: Number(night.wakes ?? 0), windows: night.usedWindows ?? [] } : null,
    }
  }

  async function lifeAction(action, b = {}) {
    const cfg = readConfig()
    const store = lifeStore(cfg, { dshHome: whaleHome })
    const live = await ipcClient('/status')
    if (!action || action === 'status') {
      return {
        ok: true,
        state: {
          ...store.status(),
          affectWorker: live.affectWorker ?? { status: 'unavailable' },
          socialWorker: live.socialWorker ?? { status: 'unavailable' },
          formationWorker: live.formationWorker ?? { status: 'unavailable', reason: '后台守护未运行' },
        },
      }
    }
    let result
    switch (action) {
      case 'dynamic-status': result = store.dynamicStatus(); break
      case 'memory-catalog': result = store.memoryCatalog(b.options ?? {}); break
      case 'memory-history': result = store.memoryHistory(b.options ?? {}); break
      case 'memory-explain': result = store.memoryExplain(String(b.id), 'local-management'); break
      case 'memory-retention': result = await store.memoryRetention(String(b.id), b); break
      case 'memory-migrate': result = await store.dynamicMigrate({ apply: b.apply === true }); break
      case 'learning-status': result = { ...store.learningStatus(), worker: live.formationWorker ?? { status: 'unavailable', reason: '后台守护未运行' } }; break
      case 'traces': result = store.decisionTraces(); break
      case 'maintain': result = await store.maintainCognition(); break
      case 'bind-channel': result = await store.bindChannel(b); break
      case 'accept':
      case 'reject': result = await store.review(String(b.id), action, { expectedRevision: b.expectedRevision }); break
      case 'revoke': result = await store.revoke(String(b.id)); break
      case 'suppress': result = await store.suppress(String(b.id), b.value !== false); break
      case 'rebuild-index': result = store.rebuildIndex(); break
      case 'replay-check': result = store.replayCheck(); break
      case 'context-explain': result = store.contextSnapshot(String(b.query ?? ''), b.scene ?? 'private-reply'); break
      case 'pause': result = await store.pause(b.value === true); break
      case 'archive': result = await store.archive(); break
      case 'export': result = store.export(); break
      case 'sources': result = store.sources(b.ids); break
      case 'search': result = store.search(String(b.query ?? ''), { archives: true }); break
      case 'close': result = await store.closeThread(String(b.thread), String(b.reason ?? 'owner')); break
      case 'reopen': result = await store.reopenThread(String(b.thread), String(b.eventId), { approved: true }); break
      case 'resolve':
        if (b.confirmed !== true) throw Error('请先回读平台确认发送结果')
        result = await store.settle(String(b.id), { status: b.status, receipt: b.receipt, verified: true })
        break
      case 'owner-note':
        result = await store.record('observed', { text: String(b.text ?? ''), origin: 'owner', actor: String(cfg.owner?.mid ?? '') })
        break
      case 'propose': result = await store.propose(b.proposal); break
      default: throw Error('未知的长期管理操作：' + action)
    }
    return { ok: true, result, state: store.status() }
  }

  async function corpusAction(action, b = {}) {
    const corpus = corpusFor(lifeStore(readConfig(), { dshHome: whaleHome }))
    if (!action || action === 'status') return { ok: true, state: corpus.status() }
    let result
    switch (action) {
      case 'list': result = corpus.list(b); break
      case 'review': result = await corpus.review(String(b.id), b.review); break
      case 'revoke': result = await corpus.revoke(String(b.id)); break
      case 'export': result = corpus.export(); break
      case 'split': result = corpus.split(); break
      default: throw Error('未知语料管理操作：' + action)
    }
    return { ok: true, result, state: corpus.status() }
  }

  async function triggerNightNow(dry = true) {
    const r = await execNode([biliMjs, 'night', 'trigger', dry ? '--dry' : '--go'], { timeout: 20_000 })
    if (!dry && r.ok) await ipcClient('/trigger-tick', { method: 'POST' })
    let parsed = null
    try { parsed = JSON.parse(r.stdout) } catch {}
    return { ok: r.ok, result: parsed, out: r.stdout.slice(0, 600), err: r.stderr.slice(0, 400) }
  }

  return {
    getSettings,
    saveSettings,
    getPersona,
    savePersona,
    qrStart: () => qrAuth.start(),
    qrPoll: (id) => qrAuth.poll(String(id ?? '')),
    qrCancel: (id) => qrAuth.cancel(String(id ?? '')),
    verifyOwner,
    getAbout,
    checkUpdate,
    applyUpdate,
    getModels,
    checkDeps,
    installFfmpeg: (opts) => ffmpegInstaller(opts),
    getPending,
    approvePending,
    rejectPending,
    notifyTest,
    getStatus,
    lifeAction,
    corpusAction,
    triggerNightNow,
    dispose: () => qrAuth.dispose(),
  }
}
