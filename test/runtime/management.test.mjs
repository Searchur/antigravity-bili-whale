/**
 * 账号登出、依赖探测竞态与配置向后兼容单元测试。
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { QrAuth, verifyAccount } from '../../src/bili/auth.mjs'
import { createTrafficGuard } from '../../src/bili/traffic.mjs'
import { createApiHandlers } from '../../src/console/api-handlers.mjs'
import { createAppToolRunner } from '../../src/mcp/app-tools.mjs'

const testCredentials = { sessdata: 'offline-test-credentials', bili_jct: 'a'.repeat(32) }

function fixture(t, options = {}) {
  const whaleHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-whale-management-'))
  const cfgFile = path.join(whaleHome, 'config.json')
  const credFile = path.join(whaleHome, 'credentials.json')
  const api = createApiHandlers({
    whaleHome, cfgFile, credFile,
    biliMjs: path.join(whaleHome, 'deps-fixture.mjs'),
    personaFile: path.join(whaleHome, 'persona.md'),
    ipcClient: async () => ({ running: false }),
    qrFetch: async () => { throw new Error('Network requests disabled') },
    ...options,
  })
  t.after(() => {
    api.dispose()
    fs.rmSync(whaleHome, { recursive: true, force: true })
  })
  return { api, whaleHome, cfgFile, credFile }
}

test('logout distinguishes a still-active remote session from verified revocation', async (t) => {
  const { api, cfgFile, credFile } = fixture(t, {
    qrFetch: async (url) => url.endsWith('/login/exit/v2')
      ? new Response(null, { status: 302 })
      : Response.json({ code: 0, data: { isLogin: true } }),
  })
  fs.writeFileSync(credFile, JSON.stringify(testCredentials))
  fs.writeFileSync(cfgFile, JSON.stringify({ self: { mid: '12', name: 'Old account' }, owner: { mid: '34' } }))

  const result = await api.logout()
  assert.equal(result.remoteRevoked, false)
  assert.equal(result.remoteStatus, 'still_active')
  assert.equal(fs.existsSync(credFile), false)
  const { config } = await api.getSettings()
  assert.equal(config.self.mid, '')
  assert.equal(config.owner.mid, '34')
})

test('logout ignores an oversized exit confirmation', async (t) => {
  const { api, credFile } = fixture(t, {
    qrFetch: async (url) => url.endsWith('/login/exit/v2')
      ? Response.json({ code: 0, padding: 'x'.repeat(128 * 1024) })
      : new Response(null, { status: 503 }),
  })
  fs.writeFileSync(credFile, JSON.stringify(testCredentials))
  assert.equal((await api.logout()).remoteStatus, 'local_only')
  assert.equal(fs.existsSync(credFile), false)
})

test('account verification preserves an unquoted Bilibili UID beyond safe integer precision', async () => {
  const account = await verifyAccount(testCredentials, {
    fetch: async () => new Response('{"code":0,"data":{"isLogin":true,"mid":1234567890123456789,"uname":"fixture"}}'),
  })
  assert.deepEqual(account, { mid: '1234567890123456789', name: 'fixture' })
})

test('cancelled QR polls stay cancelled while the shared save completes', async () => {
  const started = Promise.withResolvers()
  const saved = Promise.withResolvers()
  let milliseconds = 0
  let saves = 0
  const qr = new QrAuth({
    now: () => milliseconds,
    render: async () => 'fixture-image',
    save: async () => { saves += 1; started.resolve(); return saved.promise },
    fetch: async (url) => {
      if (String(url).includes('/generate')) {
        return Response.json({ code: 0, data: { url: 'https://passport.bilibili.com/login', qrcode_key: 'fixture' } })
      }
      return Response.json({ code: 0, data: { code: 0 } }, { headers: [
        ['set-cookie', `SESSDATA=${testCredentials.sessdata}`], ['set-cookie', `bili_jct=${testCredentials.bili_jct}`],
      ] })
    },
  })
  const { id } = await qr.start()
  milliseconds = 2000
  const first = qr.poll(id)
  const second = qr.poll(id)
  await started.promise
  qr.cancel(id)
  saved.resolve({ mid: '12345', name: 'Fixture' })
  const states = await Promise.all([first, second])
  assert.equal(saves, 1)
  assert.ok(states.every(state => state.status === 'cancelled' && !state.account))
})

test('owner verification honors the shared cooldown before reaching its injected transport', async (t) => {
  let sent = 0
  const { api, whaleHome } = fixture(t, {
    qrFetch: async () => {
      sent += 1
      return Response.json({ code: 0, data: { card: { name: 'fixture' } } })
    },
  })
  const guard = createTrafficGuard({ directory: whaleHome, transport: async () => new Response(null, { status: 429 }) })
  await guard.fetch('https://api.bilibili.com/x/web-interface/nav')
  await assert.rejects(api.verifyOwner('12345'))
  assert.equal(sent, 0)
})

test('logout reports failure when the local credential path cannot be removed', async (t) => {
  const { api, credFile } = fixture(t)
  // 凭据路径若意外指向目录，绝不可递归删除。
  fs.mkdirSync(credFile)
  await assert.rejects(api.logout(), /无法删除本地登录凭据/)
  assert.equal(fs.statSync(credFile).isDirectory(), true)
})

test('logout clears local state before remote I/O and cancels the active QR session', async (t) => {
  let finishLogout
  const exitResponse = new Promise(resolve => { finishLogout = resolve })
  const { api, cfgFile, credFile } = fixture(t, {
    qrFetch: async (url) => {
      if (url.endsWith('/login/exit/v2')) return exitResponse
      if (url.endsWith('/x/web-interface/nav')) return Response.json({ code: -101 })
      return Response.json({ code: 0, data: { url: 'https://passport.bilibili.com/login', qrcode_key: 'fixture' } })
    },
  })
  fs.writeFileSync(credFile, JSON.stringify(testCredentials))
  fs.writeFileSync(cfgFile, JSON.stringify({ self: { mid: '12', name: 'Old account' } }))
  const qr = await api.qrStart()
  const logout = api.logout()
  try {
    assert.equal(fs.existsSync(credFile), false)
    assert.equal((await api.getSettings()).config.self.mid, '')
    assert.equal((await api.qrPoll(qr.id)).status, 'cancelled')
    await assert.rejects(api.qrStart(), /正在退出登录/)
    assert.equal(api.logout(), logout)
  } finally {
    finishLogout(new Response(null, { status: 302 }))
    await logout
  }
})

test('dependency health reaches the App as a completed report with actionable cards', async (t) => {
  const { api } = fixture(t)
  const runAppTool = createAppToolRunner(api)
  const response = await runAppTool('whale_app_ops', { action: 'deps' })
  assert.equal(response.isError, undefined)
  assert.equal(response.structuredContent.ok, true)
  assert.equal(response.structuredContent.report.ok, false)
  assert.ok(response.structuredContent.report.cards.some(card => card.action === 'goto_login'))
})

test('dependency probe discards an account result after credentials change during probing', async (t) => {
  const { api, whaleHome, cfgFile, credFile } = fixture(t)
  fs.writeFileSync(credFile, JSON.stringify(testCredentials))
  fs.writeFileSync(cfgFile, JSON.stringify({ self: { mid: '12', name: 'Original' } }))
  fs.writeFileSync(path.join(whaleHome, 'deps-fixture.mjs'), `
    import fs from 'node:fs'
    import path from 'node:path'
    fs.writeFileSync(path.join(process.env.BILI_WHALE_HOME, 'credentials.json'), JSON.stringify({ sessdata: 'new-offline-fixture', bili_jct: 'b'.repeat(32) }))
    console.log(JSON.stringify({items: [{name: 'B站 cookie', ok: true, detail: '已登录：Old probe（mid 99）'}]}))
  `)
  const report = await api.checkDeps()
  assert.equal(report.self, null)
  assert.equal((await api.getSettings()).config.self.mid, '12')
})

test('management config round-trips legacy owner watch rules and preserves verified account', async (t) => {
  const { api, cfgFile, credFile } = fixture(t)
  fs.writeFileSync(credFile, JSON.stringify(testCredentials))
  fs.writeFileSync(cfgFile, JSON.stringify({
    self: { mid: '12', name: 'Verified' },
    watch: { mention: { autoMaxMin: 17, confirmMaxMin: 27, replyStyle: 'dm', mode: 'text_only' } },
    diary: { enabled: true }, notify: { type: 'file' },
  }))

  const { config } = await api.getSettings()
  const { autoMaxMin, confirmMaxMin, replyStyle, mode } = config.watch.ownerMention
  assert.deepEqual({ autoMaxMin, confirmMaxMin, replyStyle, mode }, {
    autoMaxMin: 17, confirmMaxMin: 27, replyStyle: 'dm', mode: 'always_frames',
  })
  await api.saveSettings({ persona: { name: 'Updated role' }, self: { mid: '99', name: 'Stale UI' } })
  const saved = JSON.parse(fs.readFileSync(cfgFile, 'utf8'))
  assert.deepEqual(saved.watch.ownerMention, config.watch.ownerMention)
  assert.equal(saved.self.mid, '12')
  assert.equal(Object.hasOwn(saved, 'diary'), false)
  assert.equal(Object.hasOwn(saved, 'notify'), false)
})
