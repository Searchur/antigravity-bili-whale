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
import { checkFanQuota, recordFanReply, readFanQuotaSummary, readFanQuotaHistory } from '../tools/lib/fan-quota.mjs'
import { checkLocalSafety, enforceOutboundSafety } from '../tools/lib/content-safety.mjs'
import { createSafetyReviewer } from '../lib/safety-worker.js'
import { startSidecarIpc, callSidecarIpc } from '../lib/sidecar-ipc.js'
import { buildActivityCalendar } from '../lib/activity-stats.js'
import { makePlan, normalizeTimeText } from '../tools/lib/night-plan.mjs'
import { evaluateModelQuota, createModelQuotaGuard } from '../lib/model-quota-guard.js'

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

test('v1.2.0 defaults (safety ON, interactions OFF), 3-class watch rules, verified 302 logout, local timestamped exports, open_path allowlist, and zero checkmarks work end-to-end', async () => {
  const dir = mkTmp('ag-whale-v12-')
  let exitCalled = false
  let navVerified = false
  let invalidated = 0
  const openedCalls = []
  const credFile = path.join(dir, 'credentials.json')
  fs.writeFileSync(credFile, JSON.stringify({ sessdata: 'secret-sess-value-1234567890123456', bili_jct: '0123456789abcdef0123456789abcdef', buvid3: 'b3' }))

  const api = createApiHandlers({
    whaleHome: dir,
    cfgFile: path.join(dir, 'config.json'),
    credFile,
    personaFile: path.join(dir, 'persona.md'),
    pendingFile: path.join(dir, 'pending-replies.json'),
    openPathImpl: (target, opts) => { openedCalls.push({ target, ...opts }) },
    ipcClient: async (ep) => {
      if (ep === '/invalidate') { invalidated++; return { running: true } }
      return { running: true, pid: 4321, formationWorker: { status: 'idle' }, safetyWorker: { status: 'idle', checkedCount: 0, blockedCount: 0 } }
    },
    rpc: { available: () => false },
    qrFetch: async (url) => {
      if (String(url).includes('/login/exit/v2')) {
        exitCalled = true
        return new Response('', { status: 302, headers: { location: 'https://www.bilibili.com/' } })
      }
      if (String(url).includes('/x/web-interface/nav')) {
        navVerified = true
        return new Response(JSON.stringify({ code: -101, data: { isLogin: false } }), { status: 200 })
      }
      if (String(url).includes('/x/web-interface/card?mid=12345')) {
        return new Response(JSON.stringify({ code: 0, data: { card: { name: '测试主人', sign: 'hi' } } }), { status: 200 })
      }
      return new Response(JSON.stringify({ code: -404 }), { status: 200 })
    },
  })
  try {
    // 1. Defaults: interactions ALL false, safety ON, dynamicDailyMax=1, aiCommentGuard removed, 3 watch classes present
    const init = await api.getSettings()
    assert.equal(init.config.persona.name, '大鲸鱼')
    assert.equal(init.config.browse.enabled, false)
    assert.equal(init.config.share.enabled, false)
    assert.equal('aiCommentGuard' in init.config.share, false)
    assert.equal(init.config.chat.dynamic, false)
    assert.equal(init.config.chat.dynamicDailyMax, 1)
    assert.equal(init.config.listen.dmOwner, false)
    assert.equal(init.config.listen.dmFan, false)
    assert.equal(init.config.listen.dmIntervalSec, 60)
    assert.equal(init.config.listen.commentOwner, false)
    assert.equal(init.config.listen.commentFan, false)
    assert.equal(init.config.listen.commentIntervalSec, 60)
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

    // 2. Owner check (no checkmark symbol)
    const ownerOk = await api.verifyOwner('12345', '测试主人')
    assert.equal(ownerOk.matched, true)
    assert.ok(!ownerOk.detail.includes('✓'))
    assert.equal((await api.verifyOwner('12345', '旧名字')).matched, false)

    // 3. True logout handles 302 redirect + nav verification, deletes credentials.json, clears self, notifies sidecar
    await api.saveSettings({ self: { mid: '999', name: '大鲸鱼号' } })
    const out = await api.logout()
    assert.equal(out.ok, true)
    assert.equal(exitCalled, true)
    assert.equal(navVerified, true)
    assert.equal(out.remoteRevoked, true)
    assert.equal(out.remoteStatus, 'verified_revoked')
    assert.ok(!out.detail.includes('✓'))
    assert.equal(fs.existsSync(credFile), false)
    assert.equal((await api.getSettings()).config.self.mid, '')
    assert.ok(invalidated >= 1)

    // 4. Timestamped diagnostic & memory exports write directly into exports/ without credentials
    const diag = await api.exportDiagnostics()
    assert.equal(diag.ok, true)
    assert.match(diag.filename, /^antigravity-bili-whale-diag-\d{8}-\d{6}\.json$/)
    assert.equal(fs.existsSync(diag.filePath), true)
    assert.equal(path.dirname(diag.filePath), path.join(dir, 'exports'))
    assert.ok(diag.bytes > 100)
    assert.ok(!JSON.stringify(diag.payload).includes('secret-sess-value'))

    const memExp = await api.lifeAction('export')
    assert.equal(memExp.ok, true)
    assert.match(memExp.filename, /^antigravity-whale-memory-\d{8}-\d{6}\.json$/)
    assert.equal(fs.existsSync(memExp.filePath), true)
    assert.equal(path.dirname(memExp.filePath), path.join(dir, 'exports'))

    // 5. About returns all 8 paths & openLocalPath enforces strict allowlist
    const about = await api.getAbout()
    for (const k of ['pluginRoot', 'dataDir', 'configFile', 'personaFile', 'memoryDir', 'safetyLog', 'safetyRules', 'exportsDir']) {
      assert.ok(about.paths[k], `missing about.paths.${k}`)
    }
    const openCfg = await api.openLocalPath('config_file')
    assert.equal(openCfg.ok, true)
    assert.equal(openCfg.mode, 'select')
    const openMissingLog = await api.openLocalPath('safety_log')
    assert.equal(openMissingLog.ok, true)
    assert.equal(openMissingLog.mode, 'parent_dir')
    assert.equal(openMissingLog.exists, false)
    const openExported = await api.openLocalPath('exported_file', diag.filename)
    assert.equal(openExported.ok, true)
    assert.equal(openExported.mode, 'select')
    assert.equal(openedCalls.length, 3)

    await assert.rejects(() => api.openLocalPath('unknown_key'), /不支持打开/)
    await assert.rejects(() => api.openLocalPath('exported_file', '../config.json'), /不合法/)
    await assert.rejects(() => api.openLocalPath('exported_file', 'evil.exe'), /不合法/)
    await assert.rejects(() => api.openLocalPath('exported_file', 'sub/file.json'), /不合法/)

    // 6. dynamicDailyMax clamped to 1..2, polling intervals persisted, aiCommentGuard stripped, 3-class watch config
    const saved = await api.saveSettings({
      owner: { mid: '12345', name: '测试主人' },
      share: { enabled: true, via: 'comment', aiCommentGuard: true },
      chat: { dynamic: true, dynamicDailyMax: 9 },
      listen: { commentOwner: true, commentFan: true, mentionSummaryOwner: true, mentionSummaryFan: true, dmIntervalSec: 120, commentIntervalSec: 300 },
      watch: {
        auto: { maxDurationMin: 20, minDurationSec: 45, mode: 'always_frames', frameStrategy: 'interval', frameEverySec: 10, maxFrames: 12 },
        ownerMention: { autoMaxMin: 5, confirmMaxMin: 10, replyStyle: 'comment', mode: 'auto', frameStrategy: 'grid', frameGrid: '3x3' },
        fanMention: { autoMaxMin: 3, confirmMaxMin: 5, mode: 'text_only', frameStrategy: 'interval', frameEverySec: 20, maxFrames: 9 },
      },
    })
    assert.equal(saved.config.chat.dynamicDailyMax, 2)
    assert.equal('aiCommentGuard' in saved.config.share, false)
    assert.equal(saved.config.listen.dmIntervalSec, 120)
    assert.equal(saved.config.listen.commentIntervalSec, 300)
    assert.equal(pipelineConfig(saved.config).maxDuration, 1200)
    assert.deepEqual(gridForFrameCount(12), { cols: 4, rows: 3, count: 12 })
    assert.equal(watchOptions(['BV1xx411c7mD', '--every', '10', '--max-frames', '12'], dir).everySec, 10)

    const wPrompt = wakePrompt({ atText: '2026-11-26 21:00', window: '20:00–24:00' }, '', 8, 'dm', 'direct', {}, saved.config, 2)
    assert.ok(wPrompt.includes('每 10 秒抽 1 帧'))
    assert.ok(wPrompt.includes('每日最多发 2 条'))
    assert.ok(wPrompt.includes('无需写日记'))

    // 7. Environment rows omit datadir and remove ffmpeg install/update action completely
    const deps = await api.checkDeps()
    assert.ok(Array.isArray(deps.cards))
    assert.equal(deps.cards.some(c => c.key === 'datadir'), false)
    const ffCard = deps.cards.find(c => c.key === 'ffmpeg')
    assert.ok(ffCard)
    assert.equal(ffCard.action, null)

    // 8. Global zero-checkmark invariant & v1.3.0 UI invariants across sources and built bundle
    const scanFiles = [
      'lib/api-handlers.js',
      'lib/plugin-updater.js',
      'lib/activity-stats.js',
      'ui-src/main.js',
      'ui-src/render-sections.js',
      'ui-src/render-models.js',
      'ui-src/render-watch.js',
      'ui-src/render-memory.js',
      'ui-src/render-about.js',
      'mcp/dist/app.html',
    ]
    for (const rel of scanFiles) {
      const text = fs.readFileSync(path.resolve(rel), 'utf8')
      assert.equal(text.includes('✓'), false, `${rel} must not contain ✓`)
      assert.equal(text.toLowerCase().includes('\\u2713'), false, `${rel} must not contain \\u2713`)
    }
    const bundle = fs.readFileSync(path.resolve('mcp/dist/app.html'), 'utf8')
    assert.equal(bundle.includes('疑似 AI 评论'), false)
    assert.equal(bundle.includes('告诉她一条明确偏好'), false)
    assert.equal(bundle.includes('worker-pills'), false)
    assert.equal(bundle.includes('install_ffmpeg'), false)
    assert.equal(bundle.includes('一键安装 ffmpeg'), false)
    assert.equal(bundle.includes('她目前记住的事'), false)
    assert.equal(bundle.includes('.about-hero {'), false)
    assert.equal(bundle.includes('点击任意日期查看分类统计'), false)
    assert.equal(bundle.includes('model-desc'), false)
    assert.equal(bundle.includes('悬停版本可查看完整路径'), false)
    assert.ok(bundle.includes('模型剩余配额低于多少不再活动'))
    assert.ok(bundle.includes('配额保护与会话轮换'))
    assert.ok(bundle.includes('活动统计与日历查看'))

    // Zero native browser hover tooltips (title:) across all UI source files
    for (const uiFile of ['ui-src/main.js', 'ui-src/render-sections.js', 'ui-src/render-models.js', 'ui-src/render-watch.js', 'ui-src/render-memory.js', 'ui-src/render-about.js']) {
      const uiSrc = fs.readFileSync(path.resolve(uiFile), 'utf8')
      assert.equal(/\btitle\s*:/.test(uiSrc), false, `${uiFile} must not set native hover title attribute`)
    }
    assert.ok(bundle.includes('马上唤醒她'))
    assert.ok(bundle.includes('路径：'))
    assert.ok(bundle.includes('cal-nav-group'))
    assert.ok(bundle.includes('活跃度：'))
    assert.ok(bundle.includes('累计总计'))
    assert.ok(bundle.includes('最多 50 条'))
    assert.ok(bundle.includes('最多 100 条'))
    assert.ok(bundle.includes('env-row'))
    assert.ok(bundle.includes('about-hero-card'))
    assert.ok(bundle.includes('每日最多发公开动态条数'))
    assert.ok(bundle.includes('私信轮询时间间隔'))
    assert.ok(bundle.includes('评论与 @ 轮询时间间隔'))
    assert.ok(bundle.includes('打开所在目录'))
    assert.ok(bundle.includes('定位文件'))

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

test('v1.3.0 activity calendar aggregates totals & per-day categories, preserves cross-day fan history, and respects search limit (20/50/100)', async () => {
  const dir = mkTmp('ag-whale-cal-')
  const day1 = Date.parse('2026-11-24T12:00:00+08:00')
  const day2 = Date.parse('2026-11-26T15:30:00+08:00')
  try {
    // 1. Cross-day fan quota history preserved when rolling over to a new day
    recordFanReply({ channel: 'dm', uid: '101', whaleHome: dir, now: () => day1 })
    recordFanReply({ channel: 'comment', uid: '102', whaleHome: dir, now: () => day1 })
    recordFanReply({ channel: 'mentionSummary', uid: '103', whaleHome: dir, now: () => day2 })
    const hist = readFanQuotaHistory(dir, () => day2)
    assert.equal(hist.days['2026-11-24'].dmTotal, 1)
    assert.equal(hist.days['2026-11-24'].commentTotal, 1)
    assert.equal(hist.days['2026-11-26'].mentionSummaryTotal, 1)

    // 2. Seed quota.json, safety-blocked.jsonl, whale-night.json, and life-store events
    fs.writeFileSync(path.join(dir, 'quota.json'), JSON.stringify({
      log: [
        { at: new Date(day1).toISOString(), type: 'comment', share: true, target: 'BV1aaa', note: '给主人推猫猫' },
        { at: new Date(day2).toISOString(), type: 'dynamic', share: false, target: 'dyn:1', note: '今天看了好视频' },
      ],
    }))
    fs.writeFileSync(path.join(dir, 'safety-blocked.jsonl'), JSON.stringify({
      at: new Date(day2).toISOString(),
      channel: 'comment',
      category: '合规拦截',
      reason: '命中规则',
    }) + '\n')
    fs.writeFileSync(path.join(dir, 'whale-night.json'), JSON.stringify({
      date: '2026-11-26',
      wakes: 2,
      usedCount: { '2026-11-24|20:00–24:00': 1, '2026-11-26|20:00–24:00': 2 },
    }))

    const api = createApiHandlers({
      whaleHome: dir,
      cfgFile: path.join(dir, 'config.json'),
      credFile: path.join(dir, 'credentials.json'),
      personaFile: path.join(dir, 'persona.md'),
      pendingFile: path.join(dir, 'pending-replies.json'),
      ipcClient: async () => ({ running: false }),
      rpc: { available: () => false },
    })
    try {
      await api.saveSettings({ self: { mid: '999', name: '大鲸鱼' }, owner: { mid: '12345', name: '主人' } })
      const cfg = (await api.getSettings()).config

      // Seed 26 searchable experience events to verify search limit 20 vs 50
      const { lifeStore } = await import('../tools/lib/life-runtime.mjs')
      const store = lifeStore(cfg, { dshHome: dir, now: () => day2 })
      await store.record('video-read', { target: 'BV1xyz', text: 'AI工具评测合集', data: { title: 'AI工具评测合集' } })
      await store.record('received', { actor: '12345', text: '大鲸鱼你好', data: { channel: 'bili-dm' } })
      for (let i = 1; i <= 26; i++) {
        await store.record('observed', { text: `日历搜索测试样本 ${i}`, origin: 'model' })
      }

      const cal = buildActivityCalendar({ whaleHome: dir, cfg, store, now: () => day2 })
      assert.equal(cal.today, '2026-11-26')
      assert.equal(cal.activeDays, 2)
      assert.equal(cal.totals.shares, 1)
      assert.equal(cal.totals.dynamics, 1)
      assert.equal(cal.totals.watched, 1)
      assert.equal(cal.totals.ownerInteract, 1)
      assert.equal(cal.totals.fanInteract, 3)
      assert.equal(cal.totals.wakes, 3)
      assert.equal(cal.totals.safetyBlocked, 1)
      assert.equal(cal.days['2026-11-24'].shares, 1)
      assert.equal(cal.days['2026-11-24'].fanInteract, 2)
      assert.equal(cal.days['2026-11-26'].dynamics, 1)
      assert.equal(cal.days['2026-11-26'].watched, 1)
      assert.equal(cal.days['2026-11-26'].ownerInteract, 1)
      assert.equal(cal.days['2026-11-26'].safetyBlocked, 1)

      const s20 = await api.lifeAction('search', { query: '日历搜索测试样本', limit: 20 })
      assert.equal(s20.limit, 20)
      assert.equal(s20.result.length, 20)
      const s50 = await api.lifeAction('search', { query: '日历搜索测试样本', limit: 50 })
      assert.equal(s50.limit, 50)
      assert.equal(s50.result.length, 26)
    } finally {
      api.dispose()
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('v1.4.0 normalizes 0000-2400 windows, uses segmented slots for multi-wake plans, wires wake_now via Sidecar IPC, and configures git ident in auto-release workflow', async () => {
  assert.equal(normalizeTimeText('0000'), '00:00')
  assert.equal(normalizeTimeText('2400'), '24:00')
  assert.equal(normalizeTimeText('930'), '09:30')

  // Segmented slot: 00:00-24:00 with 12 wakes at 19:00 -> remaining 5h / 12 = 25m slot
  const at19 = new Date('2026-11-26T19:00:00').getTime()
  const plan = makePlan(
    { windows: [{ start: '0000', end: '2400', wakes: 12 }], minGapMin: 10, skipChance: 0 },
    {},
    at19,
    () => 0.99,
  )
  assert.equal(plan.action, 'wake')
  assert.ok(plan.atMs - at19 <= 25 * 60_000, `expected first wake within 25m slot, got ${(plan.atMs - at19) / 60_000}m`)

  const dir = mkTmp('ag-whale-v14-')
  const ipcFile = path.join(dir, 'sidecar-ipc.json')
  let wakeCalls = 0
  let shouldFail = false
  const ipc = await startSidecarIpc({
    file: ipcFile,
    protect: () => {},
    onWakeNow: async () => {
      wakeCalls++
      if (shouldFail) throw new Error('大鲸鱼当前正在执行唤醒轮次中')
      return { ok: true, atText: '2026-11-26 19:30', requestId: 'manual-1', detail: '已立即唤醒大鲸鱼（2026-11-26 19:30）' }
    },
  })
  const api = createApiHandlers({
    whaleHome: dir,
    cfgFile: path.join(dir, 'config.json'),
    credFile: path.join(dir, 'credentials.json'),
    personaFile: path.join(dir, 'persona.md'),
    pendingFile: path.join(dir, 'pending-replies.json'),
    ipcClient: (ep, opts) => callSidecarIpc(ep, { ...opts, file: ipcFile }),
    rpc: { available: () => false },
  })
  try {
    // 0000-2400 normalized and maxWakesPerDay synced to 12
    const saved = await api.saveSettings({
      night: { windows: [{ start: '0000', end: '2400', wakes: 12 }], maxWakesPerDay: 1 },
    })
    assert.equal(saved.config.night.windows[0].start, '00:00')
    assert.equal(saved.config.night.windows[0].end, '24:00')
    assert.equal(saved.config.night.maxWakesPerDay, 12)
    await assert.rejects(() => api.saveSettings({ night: { windows: [{ start: '99:99', end: '24:00', wakes: 1 }] } }), /开始时间无效/)

    // wakeNow via Sidecar IPC succeeds & forwards business errors cleanly
    const woke = await api.wakeNow()
    assert.equal(woke.ok, true)
    assert.equal(wakeCalls, 1)
    assert.ok(woke.detail.includes('已立即唤醒大鲸鱼'))

    shouldFail = true
    await assert.rejects(() => api.wakeNow(), /正在执行唤醒轮次中/)

    // Auto-release workflow sets git identity unconditionally before tagging
    const wf = fs.readFileSync(path.resolve('.github/workflows/auto-release.yml'), 'utf8')
    const cfgIdx = wf.indexOf('git config user.name')
    const tagIdx = wf.indexOf('git tag -a')
    assert.ok(cfgIdx > 0 && tagIdx > cfgIdx, 'git config user.name must run unconditionally before git tag -a')
    assert.ok(!wf.slice(cfgIdx - 80, cfgIdx).includes('bumped =='))
  } finally {
    api.dispose()
    await ipc.close()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('v1.5.0 model quota guard pauses when below threshold, checkDeps returns structured UI cards on failure, and comment share prompt has no rule conflict', async () => {
  const sampleCatalog = {
    ok: true,
    source: 'live',
    models: [
      { id: 'gemini-4-hydrogen-medium', groupKey: 'gemini-4-hydrogen', groupName: 'Gemini 4 Hydrogen', thinkingLabel: 'Medium', remainingFraction: 0.15 },
      { id: 'gemini-4-neon-high', groupKey: 'gemini-4-neon', groupName: 'Gemini 4 Neon', thinkingLabel: 'High', remainingFraction: 0.6 },
    ],
  }
  assert.equal(evaluateModelQuota(sampleCatalog, { main: 'gemini-4-hydrogen-medium', minQuotaPercent: 0 }).paused, false)
  const low = evaluateModelQuota(sampleCatalog, { main: 'gemini-4-hydrogen-medium', minQuotaPercent: 20 })
  assert.equal(low.paused, true)
  assert.equal(low.remainingPercent, 15)
  assert.ok(low.reason.includes('低于保护阈值 20%'))

  const okQuota = evaluateModelQuota(sampleCatalog, { main: 'gemini-4-neon-high', minQuotaPercent: 20 })
  assert.equal(okQuota.paused, false)
  assert.equal(okQuota.remainingPercent, 60)

  let rpcCalls = 0
  let curThreshold = 0
  const guard = createModelQuotaGuard({
    rpc: {
      available: () => true,
      getModelCatalog: async () => { rpcCalls++; return sampleCatalog },
    },
    config: () => ({ models: { main: 'gemini-4-hydrogen-medium', minQuotaPercent: curThreshold } }),
  })
  assert.equal((await guard.check()).paused, false)
  assert.equal(rpcCalls, 0, 'zero RPC calls when minQuotaPercent === 0')
  curThreshold = 20
  assert.equal((await guard.check({ fresh: true })).paused, true)
  assert.equal(rpcCalls, 1)

  // checkDeps with missing/broken bili.mjs still returns structured cards (never raw error log with empty cards)
  const dir = mkTmp('ag-whale-v15-')
  const api = createApiHandlers({
    whaleHome: dir,
    cfgFile: path.join(dir, 'config.json'),
    credFile: path.join(dir, 'credentials.json'),
    personaFile: path.join(dir, 'persona.md'),
    pendingFile: path.join(dir, 'pending-replies.json'),
    biliMjs: path.join(dir, 'nonexistent-bili.mjs'),
    ipcClient: async () => ({ running: false }),
    rpc: { available: () => false },
  })
  try {
    const saved = await api.saveSettings({ models: { main: 'gemini-4-hydrogen-medium', minQuotaPercent: 30 } })
    assert.equal(saved.config.models.minQuotaPercent, 30)

    const failedDeps = await api.checkDeps()
    assert.equal(failedDeps.ok, false)
    assert.equal(failedDeps.error, undefined)
    assert.ok(Array.isArray(failedDeps.cards) && failedDeps.cards.length >= 6)
    assert.ok(failedDeps.cards.some(c => c.key === 'node' && c.location))
    assert.ok(failedDeps.cards.some(c => c.key === 'ffmpeg'))
    assert.ok(failedDeps.cards.some(c => c.key === 'sidecar' && c.status === 'error'))

    // Comment share prompt explicitly allows @ owner top-level comment without conflicting blanket ban
    const commentPrompt = wakePrompt(
      { atText: '2026-11-26 20:00', window: '00:00–24:00' },
      '',
      5,
      'comment',
      'direct',
      {},
      { share: { enabled: true, via: 'comment' }, chat: { dynamic: false } },
      2,
    )
    assert.ok(commentPrompt.includes('允许直接在该视频评论区发顶层评论并 @ 主人分享'))
    assert.ok(commentPrompt.includes('除上述在视频评论区「@ 主人」主动分享'))
    assert.equal(commentPrompt.includes('绝不主动给其他人的视频发顶层独白评论'), false)
  } finally {
    api.dispose()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
