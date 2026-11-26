import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { compareSemver, checkForUpdate, applyPluginUpdate } from '../lib/plugin-updater.js'
import { createApiHandlers } from '../lib/api-handlers.js'
import { wakePrompt } from '../lib/scheduler.js'

function mkTmp(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix))
}

test('plugin-updater compares semver, detects version/commit updates, guards .git, and safely applies local update without touching user data', async () => {
  assert.equal(compareSemver('1.0.1', '1.0.0'), 1)
  assert.equal(compareSemver('v1.2.0', '1.2.0'), 0)
  assert.equal(compareSemver('0.9.9', '1.0.0'), -1)

  const pluginRoot = mkTmp('ag-whale-plugin-')
  const whaleHome = mkTmp('ag-whale-home-')
  try {
    fs.writeFileSync(path.join(pluginRoot, 'plugin.json'), JSON.stringify({
      name: 'antigravity-bili-whale',
      displayName: '哔哩哔哩大鲸鱼',
      version: '1.0.0',
    }))
    // User personal data that MUST survive update untouched
    fs.writeFileSync(path.join(whaleHome, 'persona.md'), '我的专属人设')
    fs.writeFileSync(path.join(whaleHome, 'credentials.json'), '{"sessdata":"keep-me"}')

    const mockFetch = async (url) => {
      if (url.includes('/releases/latest')) return new Response('', { status: 404 })
      if (url.includes('/commits/main')) {
        return new Response(JSON.stringify({
          sha: 'abcdef1234567890abcdef1234567890abcdef12',
          html_url: 'https://github.com/Searchur/antigravity-bili-whale/commit/abcdef1',
          commit: { message: 'feat: version 1.1.0\nmore details', committer: { date: '2026-11-26T08:00:00Z' } },
        }), { status: 200, headers: { 'content-type': 'application/json' } })
      }
      if (url.includes('/contents/plugin.json')) {
        const b64 = Buffer.from(JSON.stringify({ name: 'antigravity-bili-whale', version: '1.1.0' })).toString('base64')
        return new Response(JSON.stringify({ content: b64 }), { status: 200, headers: { 'content-type': 'application/json' } })
      }
      if (url.includes('/zipball/')) {
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

    // Apply update using injectable zip extractor
    const applied = await applyPluginUpdate({
      pluginRoot,
      whaleHome,
      fetchImpl: mockFetch,
      extractZip: async (_zipFile, destDir) => {
        const root = path.join(destDir, 'Searchur-antigravity-bili-whale-abcdef1')
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

    // Verify plugin files updated while user data is 100% intact
    assert.equal(JSON.parse(fs.readFileSync(path.join(pluginRoot, 'plugin.json'), 'utf8')).version, '1.1.0')
    assert.equal(fs.readFileSync(path.join(whaleHome, 'persona.md'), 'utf8'), '我的专属人设')
    assert.equal(fs.readFileSync(path.join(whaleHome, 'credentials.json'), 'utf8'), '{"sessdata":"keep-me"}')

    // Re-checking now reports up_to_date
    const chk2 = await checkForUpdate({ pluginRoot, whaleHome, fetchImpl: mockFetch })
    assert.equal(chk2.status, 'up_to_date')
    assert.equal(chk2.hasUpdate, false)

    // Git checkout directory must refuse auto-overwrite
    fs.mkdirSync(path.join(pluginRoot, '.git'))
    await assert.rejects(() => applyPluginUpdate({ pluginRoot, whaleHome, fetchImpl: mockFetch }), /Git 开发仓库/)
  } finally {
    fs.rmSync(pluginRoot, { recursive: true, force: true })
    fs.rmSync(whaleHome, { recursive: true, force: true })
  }
})

test('hard config limits enforce 4000-char persona, max 6 liked tags, 20% skipChance steps, maxVideos 1-10, and deepWatchMax 1-3', async () => {
  const dir = mkTmp('ag-whale-limits-')
  const api = createApiHandlers({
    whaleHome: dir,
    cfgFile: path.join(dir, 'config.json'),
    credFile: path.join(dir, 'credentials.json'),
    personaFile: path.join(dir, 'persona.md'),
    pendingFile: path.join(dir, 'pending-replies.json'),
    ipcClient: async () => ({ running: true }),
    rpc: { available: () => false },
  })
  try {
    // Default liked tags are tech/news focused (<= 6) and default skipChance is 0.2
    const init = await api.getSettings()
    assert.deepEqual(init.config.preferences.like, ['AI 工具', '科技新闻', '编程开发', '效率软件'])
    assert.equal(init.config.night.skipChance, 0.2)
    assert.equal(init.config.night.deepWatchMax, 3)

    // Persona hard limit: 4000 passes, 4001 rejects
    const okP = await api.savePersona('鲸'.repeat(4000))
    assert.equal(okP.ok, true)
    await assert.rejects(() => api.savePersona('鲸'.repeat(4001)), /4000/)

    // Liked tags hard limit: 6 passes, 7 rejects
    const ok6 = await api.saveSettings({ preferences: { like: ['AI 工具', '科技新闻', '编程开发', '效率软件', '数码评测', '科普'] } })
    assert.equal(ok6.config.preferences.like.length, 6)
    await assert.rejects(() => api.saveSettings({ preferences: { like: ['1', '2', '3', '4', '5', '6', '7'] } }), /最多设置 6 个/)

    // Night clamps: skipChance snapped to 20% steps (max 0.8), maxVideos capped 1..10, deepWatchMax capped 1..3 and <= maxVideos, minGapMin >= 10
    const s1 = await api.saveSettings({
      night: {
        windows: [{ start: '20:00', end: '24:00', wakes: 2 }],
        skipChance: 0.95,
        minGapMin: 3,
        maxVideos: 25,
        deepWatchMax: 8,
      },
    })
    assert.equal(s1.config.night.skipChance, 0.8)
    assert.equal(s1.config.night.minGapMin, 10)
    assert.equal(s1.config.night.maxVideos, 10)
    assert.equal(s1.config.night.deepWatchMax, 3)

    // When maxVideos=2 and deepWatchMax=3, deepWatchMax is bounded by maxVideos
    const s2 = await api.saveSettings({
      night: {
        windows: [{ start: '20:00', end: '24:00', wakes: 1 }],
        skipChance: 0.35,
        maxVideos: 2,
        deepWatchMax: 3,
      },
    })
    assert.equal(s2.config.night.skipChance, 0.4)
    assert.equal(s2.config.night.maxVideos, 2)
    assert.equal(s2.config.night.deepWatchMax, 2)

    // wakePrompt honors dynamic maxVideos & deepWatchMax
    const prompt1 = wakePrompt({ atText: '2026-11-26 21:00', window: '20:00–24:00' }, '', 6, 'dm', 'direct', {}, {}, 1)
    assert.ok(prompt1.includes('≤6 条'))
    assert.ok(prompt1.includes('1 条 深读'))
    const prompt2 = wakePrompt({ atText: '2026-11-26 21:00', window: '20:00–24:00' }, '', 8, 'dm', 'direct', {}, {}, 2)
    assert.ok(prompt2.includes('≤8 条'))
    assert.ok(prompt2.includes('1–2 条 深读'))
  } finally {
    api.dispose()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
