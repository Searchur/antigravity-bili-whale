/**
 * MCP 服务器单元测试：覆盖全局入口声明、app-only 工具隔离、stdio JSON-RPC 与读写分离工具。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { createMcpRouter } from '../../src/mcp/server.mjs'
import { APP_URI } from '../../src/mcp/app-tools.mjs'
import { createApiHandlers } from '../../src/console/api-handlers.mjs'
import { createModelToolRunner } from '../../src/mcp/model-tools.mjs'

function mkTmp(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix))
}

test('R01 global entry opens the UI without querying or returning private bootstrap data', async () => {
  const privateReads = []
  const api = Object.fromEntries(['getSettings', 'getStatus', 'getAbout'].map(name => [
    name, () => { privateReads.push(name); return { marker: 'fixture-private-calendar' } },
  ]))
  const router = createMcpRouter({ api })
  const { result } = await router.handleRequest({ jsonrpc: '2.0', id: 1, method: 'tools/call',
    params: { name: 'open_bili_whale', arguments: {} } })
  assert.deepEqual(privateReads, [])
  assert.deepEqual(result.structuredContent, { ok: true })
  assert.doesNotMatch(JSON.stringify(result.content), /fixture-private-calendar/)
})

test('MCP router declares global-only sidebar entrypoint, app-only UI tools, and 2 read/write model tools', async () => {
  const dir = mkTmp('ag-whale-mcp-')
  const api = createApiHandlers({
    whaleHome: dir,
    cfgFile: path.join(dir, 'config.json'),
    credFile: path.join(dir, 'credentials.json'),
    personaFile: path.join(dir, 'persona.md'),
    ipcClient: async () => ({ running: false }),
    rpc: { available: () => false },
  })
  const router = createMcpRouter({ api, modelRunner: createModelToolRunner({ whaleHome: dir, cfgFile: path.join(dir, 'config.json') }) })

  try {
    const init = await router.handleRequest({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26' } })
    assert.ok(init.result.capabilities.tools)
    assert.ok(init.result.capabilities.resources)
    assert.equal(init.result.serverInfo.name, 'antigravity-bili-whale')

    const toolsRes = await router.handleRequest({ jsonrpc: '2.0', id: 2, method: 'tools/list' })
    const tools = toolsRes.result.tools

    // 仅声明左侧栏全局入口，标题为「哔哩哔哩大鲸鱼」
    const openTool = tools.find(t => t.name === 'open_bili_whale')
    assert.ok(openTool)
    assert.equal(openTool._meta.ui.resourceUri, APP_URI)
    assert.equal(APP_URI, 'ui://antigravity-bili-whale/app.html')
    assert.deepEqual(openTool._meta['com.google.antigravity/ui'].entrypoints, [{ type: 'global', title: '哔哩哔哩大鲸鱼' }])

    // 6 个管理页专用工具均标记为 app-only 对模型隐藏（已移除旧 pending/corpus）
    const appTools = tools.filter(t => t.name.startsWith('whale_app_'))
    assert.equal(appTools.length, 6)
    for (const t of appTools) assert.deepEqual(t._meta.ui.visibility, ['app'])

    // 鉴权工具仅支持扫码登录与登出，严禁手动导入 Cookie
    const authTool = tools.find(t => t.name === 'whale_app_auth')
    assert.deepEqual(authTool.inputSchema.properties.action.enum, ['qr_start', 'qr_poll', 'qr_cancel', 'logout'])
    const badAuth = await router.handleRequest({ jsonrpc: '2.0', id: 21, method: 'tools/call', params: { name: 'whale_app_auth', arguments: { action: 'cookie' } } })
    assert.equal(badAuth.result.isError, true)

    // 面向模型的读写分离工具对：bili_read 与 bili_write
    const modelTools = tools.filter(t => t.name.startsWith('bili_'))
    assert.deepEqual(modelTools.map(t => t.name), ['bili_read', 'bili_write'])
    for (const t of modelTools) assert.deepEqual(t._meta.ui.visibility, ['model'])
    const sidecarManifest = JSON.parse(fs.readFileSync(path.resolve('sidecars/whale/sidecar.json'), 'utf8'))
    assert.deepEqual(sidecarManifest.agent_permissions.access_grants, [
      'mcp(antigravity-bili-whale_whale/bili_read)',
      'mcp(antigravity-bili-whale_whale/bili_write)',
    ])

    // 预打包单文件控制台资源存在、MIME 类型匹配且包含核心视图
    const resRead = await router.handleRequest({ jsonrpc: '2.0', id: 3, method: 'resources/read', params: { uri: APP_URI } })
    const content = resRead.result.contents[0]
    assert.equal(content.mimeType, 'text/html;profile=mcp-app')
    assert.ok(content.text.includes('<!DOCTYPE html>'))
    assert.ok(content.text.includes('哔哩哔哩大鲸鱼'))
    assert.ok(!content.text.includes('手动导入 Cookie'))
    assert.ok(Buffer.byteLength(content.text, 'utf8') < 10 * 1024 * 1024)

    // bootstrap 工具返回包含模型清单与关于元数据的结构化载荷
    const boot = await router.handleRequest({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'whale_app_bootstrap', arguments: {} } })
    assert.equal(boot.result.structuredContent.ok, true)
    assert.equal(boot.result.structuredContent.settings.config.models.main, 'flash')
    assert.ok(Array.isArray(boot.result.structuredContent.models.groups))
    assert.ok(boot.result.structuredContent.models.groups.length >= 1)
    assert.equal(boot.result.structuredContent.about.local.name, 'antigravity-bili-whale')

    // ops 的 about/models 正常工作，已下线 install_ffmpeg 并开放 wake_now
    const opsTool = tools.find(t => t.name === 'whale_app_ops')
    assert.equal(opsTool.inputSchema.properties.action.enum.includes('install_ffmpeg'), false)
    assert.equal(opsTool.inputSchema.properties.action.enum.includes('wake_now'), true)
    const badOps = await router.handleRequest({ jsonrpc: '2.0', id: 39, method: 'tools/call', params: { name: 'whale_app_ops', arguments: { action: 'install_ffmpeg' } } })
    assert.equal(badOps.result.isError, true)
    const opsAbout = await router.handleRequest({ jsonrpc: '2.0', id: 40, method: 'tools/call', params: { name: 'whale_app_ops', arguments: { action: 'about' } } })
    assert.equal(opsAbout.result.structuredContent.ok, true)
    assert.ok(opsAbout.result.structuredContent.local.repository.includes('github.com/Searchur/antigravity-bili-whale'))
    const opsModels = await router.handleRequest({ jsonrpc: '2.0', id: 41, method: 'tools/call', params: { name: 'whale_app_ops', arguments: { action: 'models' } } })
    assert.equal(opsModels.result.structuredContent.ok, true)
    assert.ok(Array.isArray(opsModels.result.structuredContent.groups))

    // 模型只读工具实际调用：bili_read stickers list
    const stickers = await router.handleRequest({ jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'bili_read', arguments: { command: 'stickers', args: ['list'] } } })
    assert.equal(stickers.result.isError, false)
    assert.equal(JSON.parse(stickers.result.content[0].text).total, 42)

    // bili_read 严格拦截写命令（保持读写分离）
    const badCmd = await router.handleRequest({ jsonrpc: '2.0', id: 6, method: 'tools/call', params: { name: 'bili_read', arguments: { command: 'comment' } } })
    assert.equal(badCmd.result.isError, true)

    // 内置跨平台只读辅助命令 read-prompt 与 read-shot 作用域校验
    const pDir = path.join(dir, 'runtime', 'workspace', '.prompts')
    fs.mkdirSync(pDir, { recursive: true })
    const promptName = 'a'.repeat(48) + '.json'
    fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ self: { mid: '1001' }, owner: { mid: '2001' } }))
    fs.writeFileSync(path.join(pDir, promptName), JSON.stringify({
      account: '1001', owner: '2001', expiresAt: Date.now() + 60_000, text: 'hello full prompt',
    }))
    const promptCall = { jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'bili_read', arguments: { command: 'read-prompt', args: [promptName] } } }
    const pRes = await router.handleRequest(promptCall)
    assert.equal(pRes.result.isError, false)
    assert.equal(pRes.result.content[0].text, 'hello full prompt')
    fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ self: { mid: '1001' }, owner: { mid: '2002' } }))
    assert.equal((await router.handleRequest(promptCall)).result.isError, true)

    const sDir = path.join(dir, 'cache', 'shots')
    fs.mkdirSync(sDir, { recursive: true })
    fs.writeFileSync(path.join(sDir, 'frame.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]))
    const sRes = await router.handleRequest({ jsonrpc: '2.0', id: 8, method: 'tools/call', params: { name: 'bili_read', arguments: { command: 'read-shot', args: ['frame.png'] } } })
    assert.equal(sRes.result.isError, false)
    assert.equal(sRes.result.content[1].type, 'image')
    assert.equal(sRes.result.content[1].mimeType, 'image/png')
  } finally {
    router.dispose()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('MCP stdio server process handles newline-delimited JSON-RPC over stdin/stdout', async () => {
  const dir = mkTmp('ag-whale-stdio-')
  const serverPath = path.resolve('src/mcp/server.mjs')
  const child = spawn(process.execPath, [serverPath], {
    env: { ...process.env, BILI_WHALE_HOME: dir },
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  })
  const closed = new Promise(resolve => child.once('close', resolve))
  try {
    const lines = []
    let buf = ''
    const waitForCount = (n) => new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('stdio timeout')), 10_000)
      const check = () => {
        if (lines.length >= n) { clearTimeout(timer); resolve() }
      }
      child.stdout.on('data', chunk => {
        buf += chunk.toString('utf8')
        let idx
        while ((idx = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, idx).trim()
          buf = buf.slice(idx + 1)
          if (line) lines.push(JSON.parse(line))
        }
        check()
      })
      check()
    })

    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26' } }) + '\n')
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n')
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'ping' }) + '\n')
    await waitForCount(2)
    assert.equal(lines[0].id, 1)
    assert.equal(lines[0].result.serverInfo.name, 'antigravity-bili-whale')
    assert.equal(lines[1].id, 2)
    assert.deepEqual(lines[1].result, {})
    assert.equal(fs.statSync(path.join(dir, 'runtime', 'workspace')).isDirectory(), true)
  } finally {
    child.stdin.end()
    child.kill()
    await closed
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
