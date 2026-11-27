/**
 * Antigravity 宿主 RPC 客户端：拉取实时模型清单、规范化家族与 Thinking 档位排序。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFile } from 'node:child_process'

export const TIER_MODELS = Object.freeze([
  {
    id: 'flash',
    label: '自动 · Flash 档位（均衡推荐）',
    groupKey: 'auto-tier',
    groupName: '自动档位（随 Antigravity 自动更新）',
    thinkingLevel: 'flash',
    thinkingLabel: 'Flash（均衡）',
    tagTitle: '推荐',
    tagDescription: '自动映射到 Antigravity 当前主力高效模型，无需随版本下线手动切换。',
    supportsImages: true,
    remainingFraction: null,
  },
  {
    id: 'flash_lite',
    label: '自动 · Flash Lite 档位（极速省配额）',
    groupKey: 'auto-tier',
    groupName: '自动档位（随 Antigravity 自动更新）',
    thinkingLevel: 'flash_lite',
    thinkingLabel: 'Flash Lite（省配额）',
    tagTitle: '后台推荐',
    tagDescription: '自动映射到 Antigravity 当前轻量模型，适合记忆归纳、安全复审与心情分析。',
    supportsImages: true,
    remainingFraction: null,
  },
  {
    id: 'pro',
    label: '自动 · Pro 档位（深度推理）',
    groupKey: 'auto-tier',
    groupName: '自动档位（随 Antigravity 自动更新）',
    thinkingLevel: 'pro',
    thinkingLabel: 'Pro（深度）',
    tagTitle: '',
    tagDescription: '自动映射到 Antigravity 当前旗舰深度推理模型。',
    supportsImages: true,
    remainingFraction: null,
  },
])

/**
 * 将 GetCascadeModelConfigData 原始响应规整为前端可直接渲染的完整分组模型清单。
 */
export function normalizeModelCatalog(raw) {
  const configs = Array.isArray(raw?.clientModelConfigs) ? raw.clientModelConfigs : []
  const groupedMeta = raw?.groupedModels && typeof raw.groupedModels === 'object' ? raw.groupedModels : {}
  const sortLabels = raw?.clientModelSorts?.[0]?.groups?.[0]?.modelLabels
  const orderMap = new Map(Array.isArray(sortLabels) ? sortLabels.map((lbl, idx) => [lbl, idx]) : [])

  const enabled = configs
    .filter(m => m && !m.disabled && typeof m.modelId === 'string' && m.modelId.trim())
    .sort((a, b) => {
      const ia = orderMap.has(a.label) ? orderMap.get(a.label) : 9999
      const ib = orderMap.has(b.label) ? orderMap.get(b.label) : 9999
      return ia - ib
    })

  const groupEntries = Object.entries(groupedMeta)
  const models = []
  const groupMap = new Map()

  for (const cfg of enabled) {
    const id = cfg.modelId.trim()
    const label = String(cfg.label || id)
    let groupKey = id
    let groupName = label
    let thinkingLevel = ''
    let thinkingLabel = '默认'

    for (const [prefix, meta] of groupEntries) {
      if (id.startsWith(prefix + '-')) {
        const suffix = id.slice(prefix.length + 1)
        const level = (meta.supportedThinkingLevels || []).find(l => l.thinkingSuffix === suffix)
        if (level) {
          groupKey = prefix
          groupName = meta.displayName || prefix
          thinkingLevel = suffix
          thinkingLabel = level.thinkingDisplayName || suffix
          break
        }
      }
    }

    // 将编排器变体统一归入 orchestrator 模型家族分组
    if (groupKey === id && /^Orchestrator\s*\((.+)\)$/i.test(label)) {
      groupKey = 'orchestrator'
      groupName = 'Orchestrator'
      thinkingLabel = label.match(/\((.+)\)/)[1]
      thinkingLevel = id
    }

    const item = {
      id,
      label,
      groupKey,
      groupName,
      thinkingLevel,
      thinkingLabel,
      tagTitle: String(cfg.tagTitle || ''),
      tagDescription: String(cfg.tagDescription || ''),
      supportsImages: cfg.supportsImages !== false,
      remainingFraction: typeof cfg.quotaInfo?.remainingFraction === 'number' ? cfg.quotaInfo.remainingFraction : null,
      resetTime: cfg.quotaInfo?.resetTime || null,
    }
    models.push(item)

    if (!groupMap.has(groupKey)) {
      groupMap.set(groupKey, {
        key: groupKey,
        name: groupName,
        tagTitle: item.tagTitle,
        tagDescription: item.tagDescription,
        supportsImages: item.supportsImages,
        remainingFraction: item.remainingFraction,
        variants: [],
      })
    }
    const grp = groupMap.get(groupKey)
    grp.variants.push(item)
  }

  // 按 Low -> Medium -> High -> Extra High 整理每个家族内的思考档位顺序
  const EFFORT_RANK = { low: 1, medium: 2, high: 3, xhigh: 4 }
  for (const grp of groupMap.values()) {
    grp.variants.sort((a, b) => (EFFORT_RANK[a.thinkingLevel] ?? 99) - (EFFORT_RANK[b.thinkingLevel] ?? 99))
  }

  const tierGroup = {
    key: 'auto-tier',
    name: '自动档位（随 Antigravity 自动更新）',
    tagTitle: '自适应',
    tagDescription: '自动跟随当前版本对应档位，不会因旧模型下线而失效。',
    supportsImages: true,
    remainingFraction: null,
    variants: [...TIER_MODELS],
  }

  return {
    ok: true,
    source: models.length ? 'live' : 'fallback',
    total: models.length + TIER_MODELS.length,
    liveCount: models.length,
    groups: [tierGroup, ...groupMap.values()],
    models: [...TIER_MODELS, ...models],
  }
}

export function fallbackModelCatalog(reason = '') {
  return {
    ...normalizeModelCatalog({}),
    source: 'fallback',
    note: reason || '未连接到 Antigravity Language Server，暂时仅显示自适应档位。',
  }
}

/**
 * 解析 Antigravity App 数据根目录（包含 brain/<convId>/.system_generated/logs/）。
 */
export function resolveAppDataDir(env = process.env) {
  if (env.ANTIGRAVITY_APP_DATA_DIR) return path.resolve(env.ANTIGRAVITY_APP_DATA_DIR)
  const execData = env.ANTIGRAVITY_EXECUTABLE_DATA_DIR
  if (execData) {
    let d = path.resolve(execData)
    while (d !== path.dirname(d)) {
      if (path.basename(d).toLowerCase() === 'sidecar_data') return path.dirname(d)
      d = path.dirname(d)
    }
  }
  return path.join(env.USERPROFILE || os.homedir(), '.gemini', 'antigravity')
}

/**
 * 解析 agentapi 可执行命令（Windows Antigravity App）。
 */
export function resolveAgentApiCommand(env = process.env) {
  if (env.ANTIGRAVITY_AGENTAPI_EXE && fs.existsSync(env.ANTIGRAVITY_AGENTAPI_EXE)) {
    return { file: env.ANTIGRAVITY_AGENTAPI_EXE, prefix: ['agentapi'] }
  }
  const localApp = env.LOCALAPPDATA || ''
  const defaultLs = path.join(localApp, 'Programs', 'antigravity', 'resources', 'bin', 'language_server.exe')
  if (localApp && fs.existsSync(defaultLs)) {
    return { file: defaultLs, prefix: ['agentapi'] }
  }
  const bat = path.join(resolveAppDataDir(env), 'bin', 'agentapi.bat')
  if (fs.existsSync(bat)) return { file: 'cmd.exe', prefix: ['/d', '/c', bat] }
  return { file: 'agentapi', prefix: [] }
}

/**
 * 创建 Antigravity Language Server / ConversationService 客户端。
 */
export function createAntigravityRpc({ env = process.env, fetchImpl = globalThis.fetch, execFileImpl = execFile } = {}) {
  const getAddr = () => String(env.ANTIGRAVITY_LS_ADDRESS || '').trim()
  const getCsrf = () => String(env.ANTIGRAVITY_CSRF_TOKEN || '').trim()
  const getProjectId = () => String(env.ANTIGRAVITY_PROJECT_ID || '').trim()
  const appDataDir = () => resolveAppDataDir(env)

  const available = () => Boolean(getAddr() && getCsrf())

  async function callService(service, method, body = {}, { signal, timeoutMs = 30_000, connect = true } = {}) {
    const addr = getAddr()
    const csrf = getCsrf()
    if (!addr || !csrf) {
      throw Object.assign(new Error('Antigravity Language Server 环境变量缺失（ANTIGRAVITY_LS_ADDRESS / ANTIGRAVITY_CSRF_TOKEN）'), { code: 'AGY_HOST_UNAVAILABLE' })
    }
    const controller = new AbortController()
    const onAbort = () => controller.abort(signal?.reason)
    signal?.addEventListener('abort', onAbort, { once: true })
    if (signal?.aborted) onAbort()
    const timer = setTimeout(() => controller.abort(Object.assign(new Error(`Antigravity RPC ${method} 超时`), { code: 'AGY_RPC_TIMEOUT' })), timeoutMs)
    try {
      const headers = {
        'Content-Type': 'application/json',
        'x-antigravity-csrf-token': csrf,
        'x-codeium-csrf-token': csrf,
      }
      if (connect) headers['Connect-Protocol-Version'] = '1'
      const res = await fetchImpl(`http://${addr}/${service}/${method}`, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: controller.signal,
      })
      const text = await res.text()
      let data = null
      try { data = text ? JSON.parse(text) : {} } catch { data = { raw: text } }
      if (!res.ok) {
        const msg = data?.message || data?.error || text.slice(0, 300) || `HTTP ${res.status}`
        const code = res.status === 404 || data?.code === 'not_found' ? 'session/not-found' : `AGY_HTTP_${res.status}`
        throw Object.assign(new Error(`Antigravity ${method} 失败: ${msg}`), { code, status: res.status, details: data })
      }
      return data
    } finally {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
    }
  }

  const conversationRpc = (method, body, opts) => callService('product.v1.ConversationService', method, body, { ...opts, connect: true })
  const lsRpc = (method, body, opts) => callService('exa.language_server_pb.LanguageServerService', method, body, { ...opts, connect: false })

  async function sendMessage(conversationId, content, { title = '', signal, timeoutMs = 30_000 } = {}) {
    const cmd = resolveAgentApiCommand(env)
    const args = [...cmd.prefix, 'send-message']
    if (title) args.push(`--title=${title}`)
    args.push(String(conversationId), String(content))
    return new Promise((resolve, reject) => {
      execFileImpl(cmd.file, args, {
        encoding: 'utf8',
        windowsHide: true,
        timeout: timeoutMs,
        maxBuffer: 4 * 1024 * 1024,
        env,
        signal,
      }, (err, stdout, stderr) => {
        const raw = String(stdout ?? '').trim()
        let parsed = null
        try { parsed = raw ? JSON.parse(raw) : null } catch {}
        if (err || parsed?.error) {
          const msg = String(parsed?.error || stderr || err?.message || 'agentapi send-message 失败').trim()
          const notFound = /(?:conversation|session)[^\n]{0,120}(?:not.?found|does not exist)|unknown (?:conversation|session)/i.test(msg)
          const notStarted = ['ENOENT', 'EACCES', 'EPERM', 'ERR_INVALID_ARG_VALUE'].includes(err?.code)
          const code = notStarted ? 'AGY_SEND_NOT_STARTED' : notFound ? 'session/not-found' : 'AGY_SEND_FAILED'
          const e = Object.assign(new Error(msg.slice(0, 400)), { code })
          reject(e)
          return
        }
        resolve(parsed ?? { ok: true, raw })
      })
    })
  }

  async function getModelCatalog(opts = {}) {
    if (!available()) return fallbackModelCatalog()
    try {
      const raw = await lsRpc('GetCascadeModelConfigData', {}, { timeoutMs: 10_000, ...opts })
      return normalizeModelCatalog(raw)
    } catch (e) {
      return fallbackModelCatalog(String(e?.message ?? e))
    }
  }

  return {
    available,
    appDataDir,
    getProjectId,
    createConversation: (params, opts) => conversationRpc('CreateConversation', { ...(getProjectId() ? { projectId: getProjectId() } : {}), ...params }, opts),
    getConversation: (conversationId, opts) => conversationRpc('GetConversation', { conversationId }, opts),
    listConversations: (params, opts) => conversationRpc('ListConversations', params, opts),
    updateConversation: (conversationId, annotations, opts) => conversationRpc('UpdateConversation', { conversationId, annotations }, opts),
    deleteConversation: (conversationId, opts) => conversationRpc('DeleteConversation', { conversationId }, opts),
    sendMessage,
    lsRpc,
    getModelCatalog,
  }
}
