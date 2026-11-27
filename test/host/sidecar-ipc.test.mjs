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
    // Unauthorized requests must be rejected with 403
    const unauth = await fetch(`http://127.0.0.1:${ipc.port}/status`)
    assert.equal(unauth.status, 403)
    const unauthModels = await fetch(`http://127.0.0.1:${ipc.port}/models`)
    assert.equal(unauthModels.status, 403)

    // Authorized client reads live status
    const st = await callSidecarIpc('/status', { file: ipcFile })
    assert.equal(st.running, true)
    assert.equal(st.formationWorker.status, 'idle')

    // Authorized client reads live models
    const md = await callSidecarIpc('/models', { file: ipcFile })
    assert.equal(md.running, true)
    assert.equal(md.source, 'live')
    assert.equal(md.liveCount, 2)
    assert.equal(md.groups[0].key, 'demo')

    // Authorized invalidate triggers callback
    const inv = await callSidecarIpc('/invalidate', { method: 'POST', body: { resetPlan: true }, file: ipcFile })
    assert.equal(inv.running, true)
    assert.equal(invalidatedWith, true)
  } finally {
    await ipc.close()
  }

  // After close, ipcFile is deleted and client gracefully reports running: false
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
    total: 5,
    liveCount: 2,
    groups: [
      { key: 'auto-tier', name: '自动档位', variants: [{ id: 'flash', label: 'Flash' }] },
      { key: 'gemini-4-neon', name: 'Gemini 4 Neon', variants: [{ id: 'gemini-4-neon-xhigh', label: 'Gemini 4 Neon (XHigh)', thinkingLabel: 'Extra High' }] },
    ],
    models: [
      { id: 'flash', label: 'Flash' },
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
    // Manual cookie endpoint must NOT exist
    assert.equal(api.saveCookie, undefined)

    // Initial settings defaults
    const s0 = await api.getSettings()
    assert.equal(s0.ok, true)
    assert.equal(s0.config.models.main, 'flash')
    assert.equal(s0.config.models.worker, 'flash_lite')
    assert.equal(s0.credentials.present, false)

    // Dynamic models catalog returns live groups
    const models = await api.getModels()
    assert.equal(models.source, 'live')
    assert.equal(models.liveCount, 2)
    assert.equal(models.groups[1].key, 'gemini-4-neon')

    // QR login flow starts & cancels cleanly
    const qr = await api.qrStart()
    assert.equal(qr.status, 'waiting')
    assert.ok(qr.image && qr.image.startsWith('data:image/'))
    const qrCancelled = api.qrCancel(qr.id)
    assert.equal(qrCancelled.status, 'cancelled')

    // Save settings including live Antigravity model IDs and owner
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

    // Persona save & read
    const pSave = await api.savePersona('你是一条温柔的大鲸鱼。')
    assert.equal(pSave.ok, true)
    assert.ok(pSave.bytes > 0)
    const pRead = await api.getPersona()
    assert.equal(pRead.text, '你是一条温柔的大鲸鱼。')

    // Structured dependency health cards include Node version, ffmpeg, Bilibili login action, and Sidecar PID
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

    // Life actions: strictly limited to Tab 6 UI actions (status / pause / search / export / resolve)
    const cfgFile = path.join(dir, 'config.json')
    const cfg = JSON.parse(fs.readFileSync(cfgFile, 'utf8'))
    fs.writeFileSync(cfgFile, JSON.stringify({ ...cfg, self: { mid: '10086', name: '测试大鲸鱼' } }))
    const paused = await api.lifeAction('pause', { value: true })
    assert.equal(paused.ok, true)
    assert.equal(paused.result.paused, true)
    const resumed = await api.lifeAction('pause', { value: false })
    assert.equal(resumed.ok, true)
    assert.equal(resumed.result.paused, false)
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
