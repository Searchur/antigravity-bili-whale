/**
 * Antigravity B 站鲸鱼无头后台守护进程（Sidecar 入口）。
 *
 * - 打开 Antigravity App 时由插件系统自动拉起，关闭时收到 SIGTERM/SIGINT 优雅退出。
 * - 运行生物钟调度器、私信/评论监听与 4 个内置模型后台 Worker（完成后自动归档临时会话）。
 * - 暴露仅本机回环鉴权 IPC 供左侧栏 MCP App 实时查询状态与热重载配置。
 */
import fs from 'node:fs'
import path from 'node:path'
import { PLUGIN_ROOT, WHALE_HOME, workDirPath, configPath } from '../../tools/lib/paths.mjs'
import { createAntigravityRpc } from '../../lib/antigravity-rpc.js'
import { createAntigravitySessionController } from '../../lib/antigravity-session.js'
import { startScheduler } from '../../lib/scheduler.js'
import { startSidecarIpc } from '../../lib/sidecar-ipc.js'
import { resolveWorkDir } from '../../lib/work-dir.js'

const log = (msg) => {
  try { console.error(`[${new Date().toISOString()}] ${msg}`) } catch {}
}

fs.mkdirSync(WHALE_HOME, { recursive: true })
const readMainModel = () => {
  try { return JSON.parse(fs.readFileSync(configPath, 'utf8'))?.models?.main || 'flash' }
  catch { return 'flash' }
}

const workDir = (() => {
  let homeOverride = ''
  try { homeOverride = JSON.parse(fs.readFileSync(configPath, 'utf8'))?.home ?? '' } catch {}
  return resolveWorkDir(homeOverride, workDirPath, log)
})()

const rpc = createAntigravityRpc()
const sessionController = createAntigravitySessionController({
  rpc,
  workDir,
  defaultModel: readMainModel,
})

const biliMjs = path.join(PLUGIN_ROOT, 'tools', 'bili.mjs')
let sched = null
let schedStatus = { ok: false, reason: '初始化中', at: new Date().toISOString() }

try {
  sched = startScheduler({ rpc, sessionController }, {
    whaleHome: WHALE_HOME,
    biliMjs,
    cwd: workDir,
    sessionId: 'bili-whale',
    log,
  })
  schedStatus = {
    ok: true,
    reason: rpc.available()
      ? '后台守护运行中（每 60 秒 tick，已连接 Antigravity）'
      : '后台守护已启动，等待 Antigravity 会话环境变量就绪',
    at: new Date().toISOString(),
  }
} catch (e) {
  schedStatus = { ok: false, reason: String(e?.message ?? e).slice(0, 300), at: new Date().toISOString() }
  log('[bili-whale] 生物钟启动失败：' + e.message)
}

const ipc = await startSidecarIpc({
  getStatus: () => ({
    schedulerStatus: { ...schedStatus, rpcAvailable: rpc.available() },
    affectWorker: sched?.affectStatus?.() ?? { status: 'unavailable' },
    diaryWorker: sched?.diaryStatus?.() ?? { status: 'unavailable' },
    socialWorker: sched?.socialStatus?.() ?? { status: 'unavailable' },
    formationWorker: sched?.formationStatus?.() ?? { status: 'unavailable' },
  }),
  getModels: () => rpc.getModelCatalog(),
  onInvalidate: (resetPlan) => { sched?.invalidate(resetPlan) },
  onTriggerTick: () => { sched?.tick?.() },
})

log(`[bili-whale] Sidecar IPC 已就绪（127.0.0.1:${ipc.port} · rpcAvailable=${rpc.available()}）`)

let shuttingDown = false
async function shutdown(signalName) {
  if (shuttingDown) return
  shuttingDown = true
  log(`[bili-whale] 收到 ${signalName}，正在优雅停止后台守护...`)
  try { sched?.stop() } catch {}
  try { await ipc.close() } catch {}
  process.exit(0)
}

process.on('SIGINT', () => void shutdown('SIGINT'))
process.on('SIGTERM', () => void shutdown('SIGTERM'))
process.on('SIGHUP', () => void shutdown('SIGHUP'))
