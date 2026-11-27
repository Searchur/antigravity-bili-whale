/**
 * Sidecar 本机回环鉴权 IPC 服务端与客户端：供控制台实时查询状态、模型、安全复审与热重载。
 */
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { ipcPath } from '../core/paths.mjs'
import { renameWithRetry } from '../core/atomic-json.mjs'
import { protectPrivateFile } from '../core/file-acl.mjs'

const HEADER = 'x-whale-ipc-token'

function readBody(req, limit = 64 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks = []
    req.on('data', chunk => {
      size += chunk.length
      if (size > limit) { reject(new Error('IPC body too large')); req.destroy(); return }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

/**
 * Sidecar 侧启动本机回环鉴权 IPC（127.0.0.1 随机端口 + 随机令牌，Windows icacls 仅本人可读）。
 * 供 MCP Server 的左侧栏管理面板实时查询后台 Worker 状态并触发配置重载。
 */
export async function startSidecarIpc({
  file = ipcPath,
  getStatus = () => ({}),
  getModels = async () => ({ ok: false, error: 'unavailable' }),
  onSafetyCheck = async () => ({ checked: false, decision: 'pass' }),
  onInvalidate = () => {},
  onTriggerTick = () => {},
  onWakeNow = async () => ({ ok: false, error: '当前后台守护不支持立即唤醒' }),
  protect = protectPrivateFile,
} = {}) {
  const token = crypto.randomBytes(24).toString('hex')
  const server = http.createServer(async (req, res) => {
    const send = (code, obj) => {
      res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
      res.end(JSON.stringify(obj))
    }
    const provided = String(req.headers[HEADER] || '')
    const expected = Buffer.from(token)
    const actual = Buffer.from(provided)
    if (actual.length !== expected.length || !crypto.timingSafeEqual(actual, expected)) {
      send(403, { ok: false, error: 'forbidden' })
      return
    }
    try {
      if (req.method === 'GET' && req.url === '/status') {
        send(200, { ok: true, pid: process.pid, ...getStatus() })
        return
      }
      if (req.method === 'GET' && req.url === '/models') {
        send(200, await getModels())
        return
      }
      if (req.method === 'POST' && req.url === '/invalidate') {
        const body = JSON.parse((await readBody(req)) || '{}')
        await onInvalidate(body.resetPlan === true)
        send(200, { ok: true })
        return
      }
      if (req.method === 'POST' && req.url === '/trigger-tick') {
        await onTriggerTick()
        send(200, { ok: true })
        return
      }
      if (req.method === 'POST' && req.url === '/wake-now') {
        try {
          const out = await onWakeNow()
          send(200, { ok: true, ...(out && typeof out === 'object' ? out : {}) })
        } catch (err) {
          send(200, { ok: false, error: String(err?.message ?? err) })
        }
        return
      }
      if (req.method === 'POST' && req.url === '/safety-check') {
        const body = JSON.parse((await readBody(req)) || '{}')
        const out = await onSafetyCheck(body)
        send(200, { ok: true, ...out })
        return
      }
      send(404, { ok: false, error: 'not found' })
    } catch (err) {
      send(500, { ok: false, error: String(err?.message ?? err) })
    }
  })

  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })

  const { port } = server.address()
  const tmp = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    const fd = fs.openSync(tmp, 'wx', 0o600)
    try {
      protect(tmp)
      fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, port, token, startedAt: new Date().toISOString() }, null, 2) + '\n')
      fs.fsyncSync(fd)
    } finally { fs.closeSync(fd) }
    renameWithRetry(tmp, file)
  } catch (error) {
    await new Promise(resolve => server.close(() => resolve()))
    throw error
  } finally {
    if (fs.existsSync(tmp)) fs.rmSync(tmp, { force: true })
  }

  return {
    port,
    token,
    async close() {
      await new Promise(resolve => server.close(() => resolve()))
      try {
        const cur = JSON.parse(fs.readFileSync(file, 'utf8'))
        if (cur?.pid === process.pid) fs.rmSync(file, { force: true })
      } catch {}
    },
  }
}

/**
 * MCP Server 侧调用 Sidecar IPC；Sidecar 未运行时返回 { running: false }，绝不抛未处理异常。
 */
export async function callSidecarIpc(endpoint, { method = 'GET', body, file = ipcPath, timeoutMs = 2_500 } = {}) {
  let info
  try {
    info = JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return { running: false }
  }
  if (!info?.port || !info?.token) return { running: false }
  try {
    const res = await fetch(`http://127.0.0.1:${info.port}${endpoint}`, {
      method,
      headers: {
        [HEADER]: String(info.token),
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(timeoutMs),
      redirect: 'error',
    })
    const data = await res.json().catch(() => ({}))
    if (!res.ok) return { running: false, error: data.error || `HTTP ${res.status}` }
    return { running: true, ...data }
  } catch (err) {
    return { running: false, error: String(err?.message ?? err) }
  }
}
