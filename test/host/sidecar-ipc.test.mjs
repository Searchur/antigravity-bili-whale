/**
 * Sidecar IPC 与控制台 API 单元测试：覆盖回环鉴权、配置读写、依赖卡片与记忆操作边界。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { startSidecarIpc, callSidecarIpc } from '../../src/host/sidecar-ipc.mjs'
import { createApiHandlers } from '../../src/console/api-handlers.mjs'

function mkTmp(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix))
}

test('sidecar IPC enforces token auth, serves status/models/invalidate, and cleans up on close', async () => {
  const dir = mkTmp('ag-whale-ipc-')
  const ipcFile = path.join(dir, 'runtime', 'sidecar-ipc.json')
  let invalidatedWith = null
  const ipc = await startSidecarIpc({
    file: ipcFile,
    getStatus: () => ({ schedulerStatus: { ok: true }, formationWorker: { status: 'idle' } }),
    getModels: async () => ({ ok: true, source: 'live', liveCount: 2, groups: [{ key: 'demo', name: 'Demo', variants: [] }], models: [] }),
    onInvalidate: (resetPlan) => { invalidatedWith = resetPlan },
    protect: () => {},
  })
  try {
    // 未鉴权请求必须返回 403
    const unauth = await fetch(`http://127.0.0.1:${ipc.port}/status`)
    assert.equal(unauth.status, 403)
    const unauthModels = await fetch(`http://127.0.0.1:${ipc.port}/models`)
    assert.equal(unauthModels.status, 403)

    // 鉴权客户端可读取实时状态
    const st = await callSidecarIpc('/status', { file: ipcFile })
    assert.equal(st.running, true)
    assert.equal(st.formationWorker.status, 'idle')

    // 鉴权客户端可读取实时模型清单
    const md = await callSidecarIpc('/models', { file: ipcFile })
    assert.equal(md.running, true)
    assert.equal(md.source, 'live')
    assert.equal(md.liveCount, 2)
    assert.equal(md.groups[0].key, 'demo')

    // 鉴权调用 invalidate 应触发热重载回调
    const inv = await callSidecarIpc('/invalidate', { method: 'POST', body: { resetPlan: true }, file: ipcFile })
    assert.equal(inv.running, true)
    assert.equal(invalidatedWith, true)
  } finally {
    await ipc.close()
  }

  // 关闭后自动清理 IPC 文件，客户端平滑返回 running: false
  assert.equal(fs.existsSync(ipcFile), false)
  const after = await callSidecarIpc('/status', { file: ipcFile })
  assert.equal(after.running, false)
  fs.rmSync(dir, { recursive: true, force: true })
})

test('createApiHandlers manages settings, dynamic models, persona, structured deps cards, and life store (no manual cookie)', async () => {
  const dir = mkTmp('ag-whale-api-')
  let invalidateCalls = 0
  const liveCatalog = {
    ok: true,
    source: 'live',
    total: 1,
    liveCount: 1,
    groups: [
      { key: 'gemini-4-neon', name: 'Gemini 4 Neon', variants: [{ id: 'gemini-4-neon-xhigh', label: 'Gemini 4 Neon (XHigh)', thinkingLabel: 'Extra High' }] },
    ],
    models: [
      { id: 'gemini-4-neon-xhigh', label: 'Gemini 4 Neon (XHigh)' },
    ],
  }

  const api = createApiHandlers({
    whaleHome: dir,
    cfgFile: path.join(dir, 'config.json'),
    credFile: path.join(dir, 'credentials.json'),
    personaFile: path.join(dir, 'persona.md'),
    rpc: {
      available: () => true,
      getModelCatalog: async () => liveCatalog,
    },
    ipcClient: async (ep) => {
      if (ep === '/invalidate') { invalidateCalls++; return { running: true } }
      return { running: true, pid: 9999, formationWorker: { status: 'idle' } }
    },
    qrFetch: async () => new Response(JSON.stringify({
      code: 0,
      data: { url: 'https://passport.bilibili.com/h5-app/passport/login/scan?navhide=1', qrcode_key: 'qr_test_key_001' },
    }), { status: 200, headers: { 'content-type': 'application/json' } }),
    verify: async () => ({ mid: '10086', name: '测试大鲸鱼' }),
  })

  try {
    // 严禁暴露手动导入 Cookie 接口
    assert.equal(api.saveCookie, undefined)

    // 校验初始配置默认值
    const s0 = await api.getSettings()
    assert.equal(s0.ok, true)
    assert.equal(s0.config.models.main, 'flash')
    assert.equal(s0.config.models.worker, 'flash_lite')
    assert.equal(s0.credentials.present, false)

    // 动态模型清单返回实时分组结构
    const models = await api.getModels()
    assert.equal(models.source, 'live')
    assert.equal(models.liveCount, 1)
    assert.equal(models.groups[0].key, 'gemini-4-neon')

    // 扫码登录流程可正常启动与取消
    const qr = await api.qrStart()
    assert.equal(qr.status, 'waiting')
    assert.ok(qr.image && qr.image.startsWith('data:image/'))
    const qrCancelled = api.qrCancel(qr.id)
    assert.equal(qrCancelled.status, 'cancelled')

    // 保存实时模型 ID、主人信息与作息配置
    const saved = await api.saveSettings({
      owner: { mid: '20001', name: '主人' },
      models: { main: 'gemini-4-neon-xhigh', worker: 'claude-sonnet-5-5-low' },
      night: { windows: [{ start: '21:00', end: '23:30', wakes: 2 }], skipChance: 0.2, maxVideos: 6 },
    })
    assert.equal(saved.ok, true)
    assert.equal(saved.config.models.main, 'gemini-4-neon-xhigh')
    assert.equal(saved.config.models.worker, 'claude-sonnet-5-5-low')
    assert.equal(saved.config.night.maxWakesPerDay, 2)
    assert.equal(invalidateCalls, 1)

    // 人设正文写入与回读
    const pSave = await api.savePersona('你是一条温柔的大鲸鱼。')
    assert.equal(pSave.ok, true)
    assert.ok(pSave.bytes > 0)
    const pRead = await api.getPersona()
    assert.equal(pRead.text, '你是一条温柔的大鲸鱼。')

    // 结构化依赖卡片包含 Node.js 版本、ffmpeg、B 站登录引导与 Sidecar PID
    const deps = await api.checkDeps()
    assert.ok(Array.isArray(deps.cards))
    const nodeCard = deps.cards.find(c => c.key === 'node')
    assert.ok(nodeCard)
    assert.equal(nodeCard.ok, true)
    assert.ok(nodeCard.version.startsWith('v'))
    assert.ok(nodeCard.location.length > 0)
    const biliCard = deps.cards.find(c => c.key === 'bilibili')
    assert.ok(biliCard)
    assert.equal(biliCard.ok, false)
    assert.equal(biliCard.action, 'goto_login')
    const sidecarCard = deps.cards.find(c => c.key === 'sidecar')
    assert.ok(sidecarCard)
    assert.equal(sidecarCard.ok, true)
    assert.ok(sidecarCard.version.includes('9999'))

    // 记忆与活动接口：未登录账号时返回友好业务提示，状态接口附带身份就绪字段
    const beforeBindStatus = await api.getStatus()
    assert.equal(beforeBindStatus.identity.hasAccount, false)
    assert.equal(beforeBindStatus.identity.hasOwner, true)
    assert.equal(beforeBindStatus.identity.ready, false)
    await assert.rejects(() => api.lifeAction('pause', { value: true }), /尚未登录大鲸鱼 B 站账号/)

    // 记忆管理动作严格限定为 Tab 6 白名单操作（status / pause / search / export / resolve）
    const cfgFile = path.join(dir, 'config.json')
    const cfg = JSON.parse(fs.readFileSync(cfgFile, 'utf8'))
    fs.writeFileSync(cfgFile, JSON.stringify({ ...cfg, self: { mid: '10086', name: '测试大鲸鱼' } }))
    const paused = await api.lifeAction('pause', { value: true })
    assert.equal(paused.ok, true)
    assert.equal(paused.result.paused, true)
    assert.equal(paused.state.identity.ready, true)
    const resumed = await api.lifeAction('pause', { value: false })
    assert.equal(resumed.ok, true)
    assert.equal(resumed.result.paused, false)
    assert.ok(invalidateCalls >= 3)
    const searched = await api.lifeAction('search', { query: '测试', limit: 20 })
    assert.equal(searched.ok, true)
    assert.ok(Array.isArray(searched.result))
    await assert.rejects(() => api.lifeAction('owner-note', { text: 'retired' }), /未知的记忆管理操作/)
    await assert.rejects(() => api.lifeAction('replay-check'), /未知的记忆管理操作/)
    await assert.rejects(() => api.lifeAction('revoke', { id: 'x' }), /未知的记忆管理操作/)
    await assert.rejects(() => api.lifeAction('suppress', { id: 'x' }), /未知的记忆管理操作/)
  } finally {
    api.dispose()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('console can read exhausted models from an older running Sidecar without exposing its presets', async t => {
  const previousPreset = { id: 'flash', groupKey: 'auto-tier', remainingFraction: null }
  const depleted = { id: 'gemini-4-neon-low', groupKey: 'gemini-4-neon', remainingFraction: null, resetTime: '2026-11-29T00:00:00Z' }
  const unknown = { id: 'unreported', groupKey: 'unreported', remainingFraction: null, resetTime: null }
  const api = createApiHandlers({
    rpc: { available: () => false },
    ipcClient: async () => ({
      running: true, source: 'live', total: 3, liveCount: 2,
      models: [previousPreset, depleted, unknown],
      groups: [
        { key: 'auto-tier', variants: [previousPreset], remainingFraction: null },
        { key: 'gemini-4-neon', variants: [depleted], remainingFraction: null },
        { key: 'unreported', variants: [unknown], remainingFraction: null },
      ],
    }),
  })
  t.after(() => api.dispose())

  const result = await api.getModels()
  assert.equal(result.total, 2)
  assert.deepEqual(result.models.map(model => [model.id, model.remainingFraction]), [
    ['gemini-4-neon-low', 0], ['unreported', null],
  ])
  assert.deepEqual(result.groups.map(group => [group.key, group.remainingFraction]), [
    ['gemini-4-neon', 0], ['unreported', null],
  ])
  assert.equal(result.groups[0].variants[0].remainingFraction, 0)
})
