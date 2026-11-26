import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { compareSemver, parseLatestCommitAtom, checkForUpdate, applyPluginUpdate } from '../lib/plugin-updater.js'
import { createApiHandlers } from '../lib/api-handlers.js'
import { wakePrompt } from '../lib/scheduler.js'
import { mentionSummaryLines } from '../lib/mention-summary.js'
import { pipelineConfig } from '../tools/local/pipeline-config.mjs'
import { watchOptions, gridForFrameCount } from '../tools/lib/watch-options.mjs'
import { checkRelation, isFollowerOfWhale, clearRelationCache } from '../tools/lib/relation.mjs'
import { checkFanQuota, recordFanReply, readFanQuotaSummary } from '../tools/lib/fan-quota.mjs'
import { checkLocalSafety, enforceOutboundSafety } from '../tools/lib/content-safety.mjs'
import { createSafetyReviewer } from '../lib/safety-worker.js'
import { startSidecarIpc, callSidecarIpc } from '../lib/sidecar-ipc.js'

function mkTmp(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix))
}

test('plugin-updater uses zero-rate-limit raw/atom/codeload endpoints, detects version updates, guards .git, and preserves user data', async () => {
  assert.equal(compareSemver('1.1.0', '1.0.1'), 1)
  assert.equal(compareSemver('v1.2.0', '1.2.0'), 0)
  assert.equal(compareSemver('0.9.9', '1.0.0'), -1)

  const sampleAtom = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <entry>
    <id>tag:github.com,2008:Grit::Commit/abcdef1234567890abcdef1234567890abcdef12</id>
    <updated>2026-11-26T08:00:00Z</updated>
    <title>feat: version 1.1.0 &amp; zero-rate-limit updater</title>
  </entry>
</feed>`
  const parsedCommit = parseLatestCommitAtom(sampleAtom)
  assert.equal(parsedCommit.shortSha, 'abcdef1')
  assert.equal(parsedCommit.message, 'feat: version 1.1.0 & zero-rate-limit updater')

  const pluginRoot = mkTmp('ag-whale-plugin-')
  const whaleHome = mkTmp('ag-whale-home-')
  try {
    fs.writeFileSync(path.join(pluginRoot, 'plugin.json'), JSON.stringify({
      name: 'antigravity-bili-whale',
      displayName: '哔哩哔哩大鲸鱼',
      version: '1.0.0',
    }))
    fs.writeFileSync(path.join(whaleHome, 'persona.md'), '我的专属人设')
    fs.writeFileSync(path.join(whaleHome, 'credentials.json'), '{"sessdata":"keep-me"}')

    const mockFetch = async (url) => {
      assert.ok(!String(url).includes('api.github.com'), 'must NEVER touch rate-limited api.github.com')
      if (url.includes('raw.githubusercontent.com') && url.endsWith('/plugin.json')) {
        return new Response(JSON.stringify({ name: 'antigravity-bili-whale', version: '1.1.0' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      }
      if (url.endsWith('/commits/main.atom')) {
        return new Response(sampleAtom, { status: 200, headers: { 'content-type': 'application/atom+xml' } })
      }
      if (url.endsWith('/releases/latest')) return new Response('', { status: 200 })
      if (url.includes('codeload.github.com')) return new Response(Buffer.alloc(2048, 0x50), { status: 200 })
      return new Response('', { status: 404 })
    }

    const chk = await checkForUpdate({ pluginRoot, whaleHome, fetchImpl: mockFetch })
    assert.equal(chk.ok, true)
    assert.equal(chk.status, 'update_available')
    assert.equal(chk.remote.latestVersion, '1.1.0')

    const applied = await applyPluginUpdate({
      pluginRoot,
      whaleHome,
      fetchImpl: mockFetch,
      extractZip: async (_zipFile, destDir) => {
        const root = path.join(destDir, 'antigravity-bili-whale-main')
        fs.mkdirSync(path.join(root, 'mcp', 'dist'), { recursive: true })
        fs.mkdirSync(path.join(root, 'sidecars', 'whale'), { recursive: true })
        fs.writeFileSync(path.join(root, 'plugin.json'), JSON.stringify({ name: 'antigravity-bili-whale', version: '1.1.0' }))
        fs.writeFileSync(path.join(root, 'mcp', 'server.mjs'), '// v1.1.0 server')
        fs.writeFileSync(path.join(root, 'mcp', 'dist', 'app.html'), '<!DOCTYPE html><title>v1.1.0</title>')
        fs.writeFileSync(path.join(root, 'sidecars', 'whale', 'main.mjs'), '// v1.1.0 sidecar')
      },
    })
    assert.equal(applied.ok, true)
    assert.equal(applied.newVersion, '1.1.0')
    assert.equal(fs.readFileSync(path.join(whaleHome, 'persona.md'), 'utf8'), '我的专属人设')

    fs.mkdirSync(path.join(pluginRoot, '.git'))
    await assert.rejects(() => applyPluginUpdate({ pluginRoot, whaleHome, fetchImpl: mockFetch }), /Git 开发仓库/)
  } finally {
    fs.rmSync(pluginRoot, { recursive: true, force: true })
    fs.rmSync(whaleHome, { recursive: true, force: true })
  }
})

test('follower relation check, fan daily quotas, and dual-layer outbound safety gate enforce strict rules', async () => {
  const dir = mkTmp('ag-whale-safety-')
  clearRelationCache()
  try {
    // 1. Relation / follower verification
    const relFetch = async (url) => {
      if (url.includes('mid=101')) return new Response(JSON.stringify({ code: 0, data: { relation: { attribute: 0 }, be_relation: { attribute: 2 } } }))
      if (url.includes('mid=102')) return new Response(JSON.stringify({ code: 0, data: { relation: { attribute: 0 }, be_relation: { attribute: 0 } } }))
      if (url.includes('mid=103')) return new Response(JSON.stringify({ code: 0, data: { relation: { attribute: 128 }, be_relation: { attribute: 2 } } }))
      return new Response(JSON.stringify({ code: -400 }))
    }
    assert.equal(await isFollowerOfWhale('101', {}, { fetchImpl: relFetch, fresh: true }), true)
    assert.equal(await isFollowerOfWhale('102', {}, { fetchImpl: relFetch, fresh: true }), false)
    assert.equal(await isFollowerOfWhale('103', {}, { fetchImpl: relFetch, fresh: true }), false)
    const rel = await checkRelation('101', {}, { fetchImpl: relFetch })
    assert.equal(rel.isFollower, true)

    // 2. Fan daily quota enforcement
    const q1 = checkFanQuota({ channel: 'dm', uid: '101', perUserDaily: 2, totalDaily: 3, whaleHome: dir })
    assert.equal(q1.allowed, true)
    recordFanReply({ channel: 'dm', uid: '101', whaleHome: dir })
    recordFanReply({ channel: 'dm', uid: '101', whaleHome: dir })
    const q2 = checkFanQuota({ channel: 'dm', uid: '101', perUserDaily: 2, totalDaily: 3, whaleHome: dir })
    assert.equal(q2.allowed, false)
    recordFanReply({ channel: 'dm', uid: '202', whaleHome: dir })
    const q3 = checkFanQuota({ channel: 'dm', uid: '303', perUserDaily: 2, totalDaily: 3, whaleHome: dir })
    assert.equal(q3.allowed, false)
    const sum = readFanQuotaSummary(dir)
    assert.equal(sum.dmTotal, 3)
    assert.equal(sum.dmUsers, 2)

    // 3. Local safety redlines & custom words
    assert.equal(checkLocalSafety('这个 AI 工具剪辑教程真清晰！', {}).ok, true)
    const badBuiltin = checkLocalSafety('教你怎么线上赌场充值', {})
    assert.equal(badBuiltin.blocked, true)
    const badCustom = checkLocalSafety('大家快去买某神秘产品', { customWords: ['神秘产品'] })
    assert.equal(badCustom.blocked, true)

    // 4. Dual-layer semantic safety reviewer via Sidecar IPC /safety-check
    const reviewer = createSafetyReviewer({
      completeImpl: Object.assign(async ({ prompt }) => {
        if (prompt.includes('隐喻诱导敏感')) {
          return JSON.stringify({ decision: 'block', category: '涉政敏感诱导', reason: '检测到评论区诱导涉政风险' })
        }
        return JSON.stringify({ decision: 'pass', category: '安全', reason: '正常交流' })
      }, { available: () => true }),
    })
    const ipcFile = path.join(dir, 'sidecar-ipc.json')
    const ipc = await startSidecarIpc({
      file: ipcFile,
      onSafetyCheck: (payload) => reviewer.review(payload),
      protect: () => {},
    })
    try {
      const ipcCall = (ep, opts) => callSidecarIpc(ep, { ...opts, file: ipcFile })
      const passRes = await enforceOutboundSafety({
        text: '这段猫猫视频太可爱啦',
        channel: 'comment',
        cfg: { safety: { enabled: true, mode: 'dual', scope: 'all', customWords: [] } },
        whaleHome: dir,
        ipcClient: ipcCall,
      })
      assert.equal(passRes.ok, true)
      assert.equal(passRes.layer, 'dual')

      const blockRes = await enforceOutboundSafety({
        text: '隐喻诱导敏感内容测试',
        channel: 'comment',
        cfg: { safety: { enabled: true, mode: 'dual', scope: 'all', customWords: [] } },
        whaleHome: dir,
        ipcClient: ipcCall,
      })
      assert.equal(blockRes.blocked, true)
      assert.equal(blockRes.layer, 'model')
      assert.equal(reviewer.status().blockedCount, 1)
    } finally {
      await ipc.close()
    }
  } finally {
    clearRelationCache()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('v1.1.0 defaults (safety ON, interactions OFF), 3-class watch rules, logout, and sanitized timestamped diagnostic export work end-to-end', async () => {
  const dir = mkTmp('ag-whale-v11-')
  let exitCalled = false
  let invalidated = 0
  const credFile = path.join(dir, 'credentials.json')
  fs.writeFileSync(credFile, JSON.stringify({ sessdata: 'secret-sess-value-1234567890123456', bili_jct: '0123456789abcdef0123456789abcdef', buvid3: 'b3' }))

  const api = createApiHandlers({
    whaleHome: dir,
    cfgFile: path.join(dir, 'config.json'),
    credFile,
    personaFile: path.join(dir, 'persona.md'),
    pendingFile: path.join(dir, 'pending-replies.json'),
    ipcClient: async (ep) => {
      if (ep === '/invalidate') { invalidated++; return { running: true } }
      return { running: true, pid: 4321, formationWorker: { status: 'idle' }, safetyWorker: { status: 'idle', checkedCount: 0, blockedCount: 0 } }
    },
    rpc: { available: () => false },
    qrFetch: async (url) => {
      if (String(url).includes('/login/exit/v2')) {
        exitCalled = true
        return new Response(JSON.stringify({ code: 0 }), { status: 200 })
      }
      if (String(url).includes('/x/web-interface/card?mid=12345')) {
        return new Response(JSON.stringify({ code: 0, data: { card: { name: '测试主人', sign: 'hi' } } }), { status: 200 })
      }
      return new Response(JSON.stringify({ code: -404 }), { status: 200 })
    },
  })
  try {
    // 1. Defaults: interactions ALL false, safety ON, diary/notify/autonomy permanently disabled, 3 watch classes present
    const init = await api.getSettings()
    assert.equal(init.config.persona.name, '大鲸鱼')
    assert.equal(init.config.browse.enabled, false)
    assert.equal(init.config.share.enabled, false)
    assert.equal(init.config.chat.dynamic, false)
    assert.equal(init.config.listen.dmOwner, false)
    assert.equal(init.config.listen.dmFan, false)
    assert.equal(init.config.listen.commentOwner, false)
    assert.equal(init.config.listen.commentFan, false)
    assert.equal(init.config.listen.mentionSummaryOwner, false)
    assert.equal(init.config.listen.mentionSummaryFan, false)
    assert.equal(init.config.safety.enabled, true)
    assert.equal(init.config.safety.mode, 'dual')
    assert.equal(init.config.diary.enabled, false)
    assert.equal(init.config.life.autonomy, false)
    assert.equal(init.config.watch.auto.maxDurationMin, 15)
    assert.equal(init.config.watch.ownerMention.autoMaxMin, 5)
    assert.equal(init.config.watch.ownerMention.confirmMaxMin, 10)
    assert.equal(init.config.watch.fanMention.autoMaxMin, 3)
    assert.equal(init.config.watch.fanMention.confirmMaxMin, 5)
    assert.equal(init.config.watch.fanMention.mode, 'text_only')

    // 2. Owner check
    assert.equal((await api.verifyOwner('12345', '测试主人')).matched, true)
    assert.equal((await api.verifyOwner('12345', '旧名字')).matched, false)

    // 3. Logout revokes remote, deletes credentials.json, clears self, notifies sidecar
    await api.saveSettings({ self: { mid: '999', name: '大鲸鱼号' } })
    const out = await api.logout()
    assert.equal(out.ok, true)
    assert.equal(exitCalled, true)
    assert.equal(fs.existsSync(credFile), false)
    assert.equal((await api.getSettings()).config.self.mid, '')
    assert.ok(invalidated >= 1)

    // 4. Timestamped diagnostic export contains NO credentials
    const diag = await api.exportDiagnostics()
    assert.equal(diag.ok, true)
    assert.match(diag.filename, /^antigravity-bili-whale-diag-\d{8}-\d{6}\.json$/)
    assert.ok(!JSON.stringify(diag.payload).includes('secret-sess-value'))

    // 5. 3-class watch config & mentionSummaryLines (owner + verified follower only; stranger ignored)
    const saved = await api.saveSettings({
      owner: { mid: '12345', name: '测试主人' },
      listen: { commentOwner: true, commentFan: true, mentionSummaryOwner: true, mentionSummaryFan: true },
      watch: {
        auto: { maxDurationMin: 20, minDurationSec: 45, mode: 'always_frames', frameStrategy: 'interval', frameEverySec: 10, maxFrames: 12 },
        ownerMention: { autoMaxMin: 5, confirmMaxMin: 10, replyStyle: 'comment', mode: 'auto', frameStrategy: 'grid', frameGrid: '3x3' },
        fanMention: { autoMaxMin: 3, confirmMaxMin: 5, mode: 'text_only', frameStrategy: 'interval', frameEverySec: 20, maxFrames: 9 },
      },
    })
    assert.equal(pipelineConfig(saved.config).maxDuration, 1200)
    assert.deepEqual(gridForFrameCount(12), { cols: 4, rows: 3, count: 12 })
    assert.equal(watchOptions(['BV1xx411c7mD', '--every', '10', '--max-frames', '12'], dir).everySec, 10)

    const wPrompt = wakePrompt({ atText: '2026-11-26 21:00', window: '20:00–24:00' }, '', 8, 'dm', 'direct', {}, saved.config, 2)
    assert.ok(wPrompt.includes('每 10 秒抽 1 帧'))
    assert.ok(wPrompt.includes('无需写日记'))

    const mLines = mentionSummaryLines(saved.config, [
      { kind: 'at', mid: '12345', isFollower: true, source: '@大鲸鱼 帮我总结这个视频', oid: '1', root: '0', parent: '2' },
      { kind: 'at', mid: '88888', who: '铁粉', isFollower: true, source: '@大鲸鱼 总结一下', oid: '2', root: '0', parent: '3' },
      { kind: 'at', mid: '77777', who: '路人', isFollower: false, source: '@大鲸鱼 总结一下', oid: '3', root: '0', parent: '4' },
    ], { whaleHome: dir })
    const mText = mLines.join('\n')
    assert.ok(mText.includes('--profile owner'))
    assert.ok(mText.includes('--profile fan'))
    assert.ok(mText.includes('88888'))
    assert.ok(!mText.includes('77777'))
  } finally {
    api.dispose()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
