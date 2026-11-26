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

function mkTmp(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix))
}

test('plugin-updater uses zero-rate-limit raw/atom/codeload endpoints, detects version updates, guards .git, and preserves user data', async () => {
  assert.equal(compareSemver('1.0.1', '1.0.0'), 1)
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
  const requestedUrls = []
  try {
    fs.writeFileSync(path.join(pluginRoot, 'plugin.json'), JSON.stringify({
      name: 'antigravity-bili-whale',
      displayName: '哔哩哔哩大鲸鱼',
      version: '1.0.0',
    }))
    fs.writeFileSync(path.join(whaleHome, 'persona.md'), '我的专属人设')
    fs.writeFileSync(path.join(whaleHome, 'credentials.json'), '{"sessdata":"keep-me"}')

    const mockFetch = async (url) => {
      requestedUrls.push(String(url))
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
      if (url.endsWith('/releases/latest')) {
        return new Response('', { status: 200 })
      }
      if (url.includes('codeload.github.com')) {
        return new Response(Buffer.alloc(2048, 0x50), { status: 200 })
      }
      return new Response('', { status: 404 })
    }

    const chk = await checkForUpdate({ pluginRoot, whaleHome, fetchImpl: mockFetch })
    assert.equal(chk.ok, true)
    assert.equal(chk.status, 'update_available')
    assert.equal(chk.hasUpdate, true)
    assert.equal(chk.remote.latestVersion, '1.1.0')
    assert.equal(chk.remote.mainCommit.shortSha, 'abcdef1')

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
    assert.equal(applied.previousVersion, '1.0.0')
    assert.equal(applied.newVersion, '1.1.0')
    assert.equal(applied.requiresRestart, true)

    assert.equal(JSON.parse(fs.readFileSync(path.join(pluginRoot, 'plugin.json'), 'utf8')).version, '1.1.0')
    assert.equal(fs.readFileSync(path.join(whaleHome, 'persona.md'), 'utf8'), '我的专属人设')
    assert.equal(fs.readFileSync(path.join(whaleHome, 'credentials.json'), 'utf8'), '{"sessdata":"keep-me"}')

    const chk2 = await checkForUpdate({ pluginRoot, whaleHome, fetchImpl: mockFetch })
    assert.equal(chk2.status, 'up_to_date')
    assert.equal(chk2.hasUpdate, false)

    fs.mkdirSync(path.join(pluginRoot, '.git'))
    await assert.rejects(() => applyPluginUpdate({ pluginRoot, whaleHome, fetchImpl: mockFetch }), /Git 开发仓库/)
  } finally {
    fs.rmSync(pluginRoot, { recursive: true, force: true })
    fs.rmSync(whaleHome, { recursive: true, force: true })
  }
})

test('hard limits, defaults (persona 大鲸鱼, all share/listen unchecked), verifyOwner, and watch/mention rules work end-to-end', async () => {
  const dir = mkTmp('ag-whale-limits-')
  const api = createApiHandlers({
    whaleHome: dir,
    cfgFile: path.join(dir, 'config.json'),
    credFile: path.join(dir, 'credentials.json'),
    personaFile: path.join(dir, 'persona.md'),
    pendingFile: path.join(dir, 'pending-replies.json'),
    ipcClient: async () => ({ running: true }),
    rpc: { available: () => false },
    qrFetch: async (url) => {
      if (String(url).includes('/x/web-interface/card?mid=12345')) {
        return new Response(JSON.stringify({ code: 0, data: { card: { name: '测试主人', sign: 'hello' } } }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      }
      return new Response(JSON.stringify({ code: -404, message: '啥都木有' }), { status: 200 })
    },
  })
  try {
    // Defaults: persona.name === '大鲸鱼', all share/listen/diary switches default false, watch defaults present
    const init = await api.getSettings()
    assert.equal(init.config.persona.name, '大鲸鱼')
    assert.deepEqual(init.config.preferences.like, ['AI 工具', '科技新闻', '编程开发', '效率软件'])
    assert.equal(init.config.night.skipChance, 0.2)
    assert.equal(init.config.night.deepWatchMax, 3)
    assert.equal(init.config.share.enabled, false)
    assert.equal(init.config.listen.dm, false)
    assert.equal(init.config.listen.comment, false)
    assert.equal(init.config.listen.onlyOwner, false)
    assert.equal(init.config.listen.oncePerPerson, false)
    assert.equal(init.config.listen.allDay, false)
    assert.equal(init.config.listen.mentionSummary, false)
    assert.equal(init.config.diary.enabled, false)
    assert.equal(init.config.diary.push, false)
    assert.equal(init.config.chat.followup, false)
    assert.equal(init.config.chat.idle, false)
    assert.equal(init.config.chat.shareReply, false)
    assert.equal(init.config.chat.dynamic, false)
    assert.equal(init.config.life.autonomy, false)
    assert.equal(init.config.watch.auto.maxDurationMin, 15)
    assert.equal(init.config.watch.auto.frameEverySec, 15)
    assert.equal(init.config.watch.mention.autoMaxMin, 5)
    assert.equal(init.config.watch.mention.confirmMaxMin, 10)

    // Owner verification: matched, mismatched, and auto-lookup when nickname omitted
    const okMatch = await api.verifyOwner('12345', '测试主人')
    assert.equal(okMatch.matched, true)
    const mismatch = await api.verifyOwner('12345', '旧昵称')
    assert.equal(mismatch.matched, false)
    assert.equal(mismatch.actualName, '测试主人')
    const lookupOnly = await api.verifyOwner('12345', '')
    assert.equal(lookupOnly.matched, null)
    assert.equal(lookupOnly.actualName, '测试主人')
    await assert.rejects(() => api.verifyOwner('abc', ''), /格式不正确/)

    // Persona hard limit: 4000 passes, 4001 rejects
    const okP = await api.savePersona('鲸'.repeat(4000))
    assert.equal(okP.ok, true)
    await assert.rejects(() => api.savePersona('鲸'.repeat(4001)), /4000/)

    // Liked tags hard limit: 6 passes, 7 rejects
    const ok6 = await api.saveSettings({ preferences: { like: ['AI 工具', '科技新闻', '编程开发', '效率软件', '数码评测', '科普'] } })
    assert.equal(ok6.config.preferences.like.length, 6)
    await assert.rejects(() => api.saveSettings({ preferences: { like: ['1', '2', '3', '4', '5', '6', '7'] } }), /最多设置 6 个/)

    // Night clamps & watch normalization
    const s1 = await api.saveSettings({
      night: { windows: [{ start: '20:00', end: '24:00', wakes: 2 }], skipChance: 0.95, minGapMin: 3, maxVideos: 25, deepWatchMax: 8 },
      watch: {
        auto: { maxDurationMin: 20, minDurationSec: 45, mode: 'always_frames', frameStrategy: 'interval', frameEverySec: 10, maxFrames: 12 },
        mention: { autoMaxMin: 5, confirmMaxMin: 10, frameMode: 'auto', replyStyle: 'comment' },
      },
    })
    assert.equal(s1.config.night.skipChance, 0.8)
    assert.equal(s1.config.night.minGapMin, 10)
    assert.equal(s1.config.night.maxVideos, 10)
    assert.equal(s1.config.night.deepWatchMax, 3)
    assert.equal(s1.config.watch.auto.maxDurationMin, 20)
    assert.equal(s1.config.watch.auto.frameEverySec, 10)

    // pipelineConfig honors watch.auto duration bounds
    const pCfg = pipelineConfig(s1.config)
    assert.equal(pCfg.minDuration, 45)
    assert.equal(pCfg.maxDuration, 1200)

    // watchOptions supports --every and --max-frames
    const wOpt = watchOptions(['BV1xx411c7mD', '--every', '10', '--max-frames', '12'], dir)
    assert.equal(wOpt.everySec, 10)
    assert.equal(wOpt.maxFrames, 12)
    assert.deepEqual(gridForFrameCount(12), { cols: 4, rows: 3, count: 12 })

    // wakePrompt includes dynamic maxVideos, deepWatchMax & watch.auto rules
    const prompt = wakePrompt({ atText: '2026-11-26 21:00', window: '20:00–24:00' }, '', 8, 'dm', 'direct', {}, s1.config, 2)
    assert.ok(prompt.includes('≤8 条'))
    assert.ok(prompt.includes('1–2 条 深读'))
    assert.ok(prompt.includes('每 10 秒抽 1 帧'))

    // mentionSummaryLines builds 3-tier duration instructions & triggers on owner confirmation replies
    const mLines = mentionSummaryLines(
      { owner: { mid: '12345' }, listen: { mentionSummary: true }, watch: s1.config.watch },
      [{ kind: 'at', mid: '12345', source: '@大鲸鱼 帮我总结一下这个视频', oid: '1', root: '0', parent: '2', uri: 'https://b23.tv/x' }],
    )
    const mText = mLines.join('\n')
    assert.ok(mText.includes('≤ 5 分钟'))
    assert.ok(mText.includes('5–10 分钟'))
    assert.ok(mText.includes('> 10 分钟'))

    const confirmLines = mentionSummaryLines(
      { owner: { mid: '12345' }, listen: { mentionSummary: true }, watch: s1.config.watch },
      [{ kind: 'reply', mid: '12345', source: '确定，帮我看吧', oid: '1', root: '2', parent: '3' }],
    )
    assert.ok(confirmLines.length > 0)
  } finally {
    api.dispose()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
