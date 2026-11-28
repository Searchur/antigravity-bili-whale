/**
 * MCP Apps 前端桥接封装：负责与 Antigravity 宿主通信、明暗主题变量同步及并发请求排队。
 */
import { App, applyDocumentTheme, applyHostStyleVariables } from '@modelcontextprotocol/ext-apps'

/**
 * 创建 MCP Apps 桥接实例：
 * - 先注册事件回调再执行 connect()，避免丢失初始结果与主题变量；
 * - 内置上限为 3 的并发队列，低于宿主 4 并发限制。
 */
export function createMcpBridge({ onInitialResult } = {}) {
  const app = new App({ name: 'antigravity-bili-whale', version: '2.0.4' }, {})

  const applyContext = (ctx) => {
    if (!ctx) return
    if (ctx.theme) applyDocumentTheme(ctx.theme)
    if (ctx.styles?.variables) applyHostStyleVariables(ctx.styles.variables)
  }

  app.onhostcontextchanged = (ctx) => applyContext(ctx)
  app.ontoolresult = (result) => {
    if (result?.structuredContent && typeof onInitialResult === 'function') {
      onInitialResult(result.structuredContent)
    }
  }

  let inFlight = 0
  const queue = []
  const MAX_IN_FLIGHT = 3

  function runQueued(fn) {
    return new Promise((resolve, reject) => {
      const exec = async () => {
        inFlight++
        try { resolve(await fn()) }
        catch (e) { reject(e) }
        finally {
          inFlight--
          if (queue.length > 0 && inFlight < MAX_IN_FLIGHT) {
            const next = queue.shift()
            next()
          }
        }
      }
      if (inFlight < MAX_IN_FLIGHT) exec()
      else queue.push(exec)
    })
  }

  async function connect() {
    await app.connect()
    applyContext(app.getHostContext())
  }

  async function callTool(name, args = {}) {
    return runQueued(async () => {
      const res = await app.callServerTool({ name, arguments: args })
      let data = res?.structuredContent
      if (!data && Array.isArray(res?.content)) {
        const text = res.content.find(c => c.type === 'text')?.text
        if (text) {
          try { data = JSON.parse(text) } catch { data = { ok: !res.isError, text } }
        }
      }
      if (res?.isError || data?.ok === false) {
        throw new Error(data?.error || res?.content?.[0]?.text || '调用工具失败')
      }
      return data ?? { ok: true }
    })
  }

  async function openLink(url) {
    if (!url) return
    try {
      if (typeof app.openLink === 'function') {
        await app.openLink({ url })
        return
      }
    } catch {}
    window.open(url, '_blank', 'noopener,noreferrer')
  }

  return { app, connect, callTool, openLink }
}
