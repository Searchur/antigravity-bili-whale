import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { createMcpRouter } from '../mcp/server.mjs'
import { APP_URI } from '../mcp/app-tools.mjs'
import { createApiHandlers } from '../lib/api-handlers.js'
import { createModelToolRunner } from '../mcp/model-tools.mjs'

function mkTmp(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix))
}

test('MCP router declares global-only sidebar entrypoint, app-only UI tools, and 8 model tools', async () => {
  const dir = mkTmp('ag-whale-mcp-')
  const api = createApiHandlers({
    whaleHome: dir,
    cfgFile: path.join(dir, 'config.json'),
    credFile: path.join(dir, 'credentials.json'),
    personaFile: path.join(dir, 'persona.md'),
    pendingFile: path.join(dir, 'pending-replies.json'),
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

    // Left sidebar ONLY entrypoint with renamed title
    const openTool = tools.find(t => t.name === 'open_bili_whale')
    assert.ok(openTool)
    assert.equal(openTool._meta.ui.resourceUri, APP_URI)
    assert.equal(APP_URI, 'ui://antigravity-bili-whale/app.html')
    assert.deepEqual(openTool._meta['com.google.antigravity/ui'].entrypoints, [{ type: 'global', title: '哔哩哔哩大鲸鱼' }])

    // App-only tools hidden from AI model (6 management tools, pending/corpus retired)
    const appTools = tools.filter(t => t.name.startsWith('whale_app_'))
    assert.equal(appTools.length, 6)
    for (const t of appTools) assert.deepEqual(t._meta.ui.visibility, ['app'])

    // Auth tool supports QR login + logout, NEVER manual cookie
    const authTool = tools.find(t => t.name === 'whale_app_auth')
    assert.deepEqual(authTool.inputSchema.properties.action.enum, ['qr_start', 'qr_poll', 'qr_cancel', 'logout'])
    const badAuth = await router.handleRequest({ jsonrpc: '2.0', id: 21, method: 'tools/call', params: { name: 'whale_app_auth', arguments: { action: 'cookie' } } })
    assert.equal(badAuth.result.isError, true)

    // Model tools
    const modelTools = tools.filter(t => t.name.startsWith('bili_'))
    assert.equal(modelTools.length, 8)
    for (const t of modelTools) assert.deepEqual(t._meta.ui.visibility, ['model'])

    // Pre-bundled single-file HTML resource exists, matches MIME type, and reflects redesigned UI
    const resRead = await router.handleRequest({ jsonrpc: '2.0', id: 3, method: 'resources/read', params: { uri: APP_URI } })
    const content = resRead.result.contents[0]
    assert.equal(content.mimeType, 'text/html;profile=mcp-app')
    assert.ok(content.text.includes('<!DOCTYPE html>'))
    assert.ok(content.text.includes('哔哩哔哩大鲸鱼'))
    assert.ok(!content.text.includes('手动导入 Cookie'))
    assert.ok(Buffer.byteLength(content.text, 'utf8') < 10 * 1024 * 1024)

    // Bootstrap call returns structuredContent including models catalog and about metadata
    const boot = await router.handleRequest({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'whale_app_bootstrap', arguments: {} } })
    assert.equal(boot.result.structuredContent.ok, true)
    assert.equal(boot.result.structuredContent.settings.config.models.main, 'flash')
    assert.ok(Array.isArray(boot.result.structuredContent.models.groups))
    assert.ok(boot.result.structuredContent.models.groups.length >= 1)
    assert.equal(boot.result.structuredContent.about.local.name, 'antigravity-bili-whale')

    // Ops about & models actions work cleanly; install_ffmpeg retired; wake_now exposed
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

    // Model tool live execution: bili_stickers list
    const stickers = await router.handleRequest({ jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'bili_stickers', arguments: { command: 'list' } } })
    assert.equal(stickers.result.isError, false)
    assert.equal(JSON.parse(stickers.result.content[0].text).total, 42)

    // Disallowed command rejected cleanly
    const badCmd = await router.handleRequest({ jsonrpc: '2.0', id: 6, method: 'tools/call', params: { name: 'bili_stickers', arguments: { command: 'comment' } } })
    assert.equal(badCmd.result.isError, true)

    // Portable read-prompt & read-shot scoped helpers
    const pDir = path.join(dir, 'whale-work', '.prompts')
    fs.mkdirSync(pDir, { recursive: true })
    fs.writeFileSync(path.join(pDir, 'sample.md'), 'hello full prompt')
    const pRes = await router.handleRequest({ jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'bili_ops', arguments: { command: 'read-prompt', args: ['sample.md'] } } })
    assert.equal(pRes.result.isError, false)
    assert.equal(pRes.result.content[0].text, 'hello full prompt')

    const sDir = path.join(dir, 'shots')
    fs.mkdirSync(sDir, { recursive: true })
    fs.writeFileSync(path.join(sDir, 'frame.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]))
    const sRes = await router.handleRequest({ jsonrpc: '2.0', id: 8, method: 'tools/call', params: { name: 'bili_inspect', arguments: { command: 'read-shot', args: ['frame.png'] } } })
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
  const serverPath = path.resolve('mcp/server.mjs')
  const child = spawn(process.execPath, [serverPath], {
    env: { ...process.env, BILI_WHALE_HOME: dir },
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  })
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
  } finally {
    child.stdin.end()
    child.kill()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
