#!/usr/bin/env node
/**
 * Antigravity 哔哩哔哩大鲸鱼零运行时依赖 stdio MCP Server（JSON-RPC 2.0）。
 *
 * - 声明 tools + resources 能力，提供 ui://antigravity-bili-whale/app.html（左侧栏全页 MCP App）。
 * - 暴露 8 个面向模型的 B 站分组工具（绕开 Windows 终端沙箱断网限制）。
 * - 暴露管理页专属 app-only 工具（对 AI 模型隐藏，零 token 占用）。
 */
import fs from 'node:fs'
import path from 'node:path'
import readline from 'node:readline'
import { fileURLToPath } from 'node:url'
import { PLUGIN_ROOT, appHtmlPath, workDirPath } from '../core/paths.mjs'
import { createApiHandlers } from '../console/api-handlers.mjs'
import { resolveWorkDir } from '../core/work-dir.mjs'
import { modelToolDefinitions, createModelToolRunner } from './model-tools.mjs'
import { APP_URI, appToolDefinitions, createAppToolRunner } from './app-tools.mjs'

const DEFAULT_HTML_PATH = appHtmlPath
const SERVER_INFO = { name: 'antigravity-bili-whale', version: '2.0.2' }
const MIME_MCP_APP = 'text/html;profile=mcp-app'

function readAppHtml(htmlPath = process.env.BILI_WHALE_APP_HTML || DEFAULT_HTML_PATH) {
  if (!fs.existsSync(htmlPath)) {
    return `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><body style="font-family:system-ui;padding:24px"><h2>哔哩哔哩大鲸鱼控制台尚未构建</h2><p>未找到前端文件：${htmlPath}。开发环境下请先执行 <code>npm run build:ui</code>。</p></body></html>`
  }
  return fs.readFileSync(htmlPath, 'utf8')
}

export function createMcpRouter({ api = createApiHandlers(), modelRunner = createModelToolRunner(), htmlPath } = {}) {
  const appRunner = createAppToolRunner(api)
  const tools = [...appToolDefinitions(), ...modelToolDefinitions()]

  async function handleRequest(msg) {
    const { id, method, params = {} } = msg ?? {}
    const isNotification = id === undefined || id === null

    if (method === 'notifications/initialized' || method === 'notifications/cancelled') {
      return null
    }

    const ok = (result) => (isNotification ? null : { jsonrpc: '2.0', id, result })
    const fail = (code, message) => (isNotification ? null : { jsonrpc: '2.0', id, error: { code, message } })

    try {
      switch (method) {
        case 'initialize':
          return ok({
            protocolVersion: typeof params.protocolVersion === 'string' && params.protocolVersion ? params.protocolVersion : '2025-03-26',
            capabilities: {
              tools: {},
              resources: {},
            },
            serverInfo: SERVER_INFO,
          })

        case 'ping':
          return ok({})

        case 'tools/list':
          return ok({ tools })

        case 'tools/call': {
          const name = String(params?.name ?? '')
          const args = params?.arguments && typeof params.arguments === 'object' ? params.arguments : {}
          const appRes = await appRunner(name, args)
          if (appRes) return ok(appRes)
          const modelRes = await modelRunner(name, args)
          if (modelRes) return ok(modelRes)
          return fail(-32601, `未知工具: ${name}`)
        }

        case 'resources/list':
          return ok({
            resources: [
              {
                uri: APP_URI,
                name: '哔哩哔哩大鲸鱼控制台',
                description: '哔哩哔哩大鲸鱼独立全页管理控制台',
                mimeType: MIME_MCP_APP,
                _meta: { ui: { prefersBorder: false } },
              },
            ],
          })

        case 'resources/read': {
          const uri = String(params?.uri ?? '')
          if (uri !== APP_URI) return fail(-32002, `未找到资源: ${uri}`)
          const text = readAppHtml(htmlPath)
          return ok({
            contents: [
              {
                uri: APP_URI,
                mimeType: MIME_MCP_APP,
                text,
                _meta: { ui: { prefersBorder: false } },
              },
            ],
          })
        }

        default:
          return fail(-32601, `Method not found: ${method}`)
      }
    } catch (err) {
      return fail(-32603, String(err?.message ?? err))
    }
  }

  return { handleRequest, dispose: () => api.dispose() }
}

// 仅在直接作为主进程执行时启动 stdio MCP 服务。
const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))
if (isMain) {
  const htmlPath = process.env.BILI_WHALE_APP_HTML ? path.resolve(process.env.BILI_WHALE_APP_HTML) : undefined
  const fromPlugin = path.relative(PLUGIN_ROOT, process.cwd())
  // Windows 会锁定当前工作目录句柄，可能阻塞插件原地更新切换。
  if (fromPlugin !== '..' && !fromPlugin.startsWith('..' + path.sep) && !path.isAbsolute(fromPlugin)) {
    process.chdir(resolveWorkDir('', workDirPath))
  }
  const router = createMcpRouter({ htmlPath })
  const writeMsg = (obj) => {
    if (!obj) return
    process.stdout.write(JSON.stringify(obj) + '\n')
  }

  const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity })
  rl.on('line', async (line) => {
    const trimmed = line.trim()
    if (!trimmed) return
    let msg
    try {
      msg = JSON.parse(trimmed)
    } catch {
      writeMsg({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } })
      return
    }
    const response = await router.handleRequest(msg)
    writeMsg(response)
  })

  const cleanup = () => {
    try { router.dispose() } catch {}
    process.exit(0)
  }
  rl.on('close', cleanup)
  process.on('SIGINT', cleanup)
  process.on('SIGTERM', cleanup)
}
