import fs from 'node:fs'
import path from 'node:path'

// Windows CreateProcessW 硬限制 32,767 字符；为 argv 预留安全余量
const MAX_CLI_CONTENT_CHARS = 22_000

const ROLE_TITLES = {
  'browse-main': 'B站鲸鱼 · 浏览主线',
  'private-main': 'B站鲸鱼 · 主人私信',
  'public-task': 'B站鲸鱼 · 评论互动',
}

function extractText(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .filter(c => c && c.type === 'text' && typeof c.text === 'string')
    .map(c => c.text)
    .join('\n')
}

/**
 * Antigravity 会话控制器：替代原 DSH 的 ctx.sessionController。
 *
 * 能力对齐：
 * - createAndPrompt: 首次创建或轮换会话时，通过 ConversationService/CreateConversation
 *   在一次 HTTP JSON 请求中原子建会话并投递首条提示（不受 Windows 32KB 命令行长度限制）。
 * - prompt: 向既有会话续发消息，通过 agentapi send-message 唤醒空闲会话；若正文超过
 *   Windows 命令行安全阈值，则将完整正文写入 whale-work/.prompts/ 并提示模型用 read_file 读取。
 * - isBusy: 调用 GetConversation 精确读取 state.runState（RUN_STATE_RUNNING / CANCELLING）。
 */
export function createAntigravitySessionController({ rpc, workDir, defaultModel = () => 'flash' }) {
  const promptDir = () => path.join(workDir, '.prompts')

  function materializeLargePrompt(requestId, text) {
    if (text.length <= MAX_CLI_CONTENT_CHARS) return text
    const dir = promptDir()
    fs.mkdirSync(dir, { recursive: true })
    const safeId = String(requestId || Date.now()).replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 80)
    const file = path.join(dir, `${safeId}.md`)
    fs.writeFileSync(file, text, 'utf8')
    // 清理 24 小时前的旧临时提示文件，避免无限累积
    try {
      const cutoff = Date.now() - 24 * 3600_000
      for (const name of fs.readdirSync(dir)) {
        const full = path.join(dir, name)
        try { if (fs.statSync(full).mtimeMs < cutoff) fs.rmSync(full, { force: true }) } catch {}
      }
    } catch {}
    return [
      `【完整本轮任务上下文较长，已写入文件】`,
      `请立刻先调用 MCP 工具 bili_ops（command="read-prompt", args=["${safeId}.md"]）读取完整内容后再按其中规范执行（文件路径：${file}）。`,
      '',
      '（前 1500 字预览）',
      text.slice(0, 1500),
    ].join('\n')
  }

  return {
    available: () => rpc.available(),

    async create({ sessionRole, model, title, tags } = {}, signal) {
      const role = sessionRole || 'browse-main'
      const res = await rpc.createConversation({
        title: title || ROLE_TITLES[role] || 'B站鲸鱼',
        model: model || defaultModel(),
        tags: tags ?? ['bili-whale', `role:${role}`],
      }, { signal, timeoutMs: 30_000 })
      const id = res?.conversation?.id
      if (!id) throw new Error('Antigravity CreateConversation 未返回 conversation.id')
      return { sessionId: id }
    },

    async createAndPrompt({ sessionRole, model, title, tags, content } = {}, signal) {
      const role = sessionRole || 'browse-main'
      const text = extractText(content)
      const res = await rpc.createConversation({
        title: title || ROLE_TITLES[role] || 'B站鲸鱼',
        model: model || defaultModel(),
        tags: tags ?? ['bili-whale', `role:${role}`],
        prompt: [{ text }],
      }, { signal, timeoutMs: 45_000 })
      const id = res?.conversation?.id
      if (!id) throw new Error('Antigravity CreateConversation 未返回 conversation.id')
      return { sessionId: id }
    },

    async prompt({ sessionId, requestId, sessionRole, content } = {}, signal) {
      if (!sessionId) throw Object.assign(new Error('缺少 sessionId'), { code: 'session/not-found' })
      // 先验证会话仍存在，避免向已被删除的会话发消息造成假失败
      await rpc.getConversation(sessionId, { signal, timeoutMs: 15_000 })
      const text = materializeLargePrompt(requestId, extractText(content))
      const role = sessionRole || 'browse-main'
      return rpc.sendMessage(sessionId, text, {
        title: ROLE_TITLES[role] || 'B站鲸鱼',
        signal,
        timeoutMs: 30_000,
      })
    },

    async isBusy(sessionId) {
      if (!sessionId || !rpc.available()) return false
      try {
        const conv = await rpc.getConversation(sessionId, { timeoutMs: 5_000 })
        const rs = conv?.state?.runState
        return rs === 'RUN_STATE_RUNNING' || rs === 'RUN_STATE_CANCELLING'
      } catch {
        return false
      }
    },
  }
}
