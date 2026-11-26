import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-whale-paths-'))
process.env.BILI_WHALE_HOME = tmpRoot

const paths = await import('../tools/lib/paths.mjs')
const { listStickers, getSticker, stickerHint } = await import('../tools/lib/stickers.mjs')
const { config, normalizeModels, MODEL_DEFAULTS } = await import('../tools/lib/config.mjs')

test.after(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true })
})

test('isolated WHALE_HOME never points to .dsh or .bili-ai', () => {
  assert.equal(paths.WHALE_HOME, tmpRoot)
  assert.equal(paths.credentialsPath, path.join(tmpRoot, 'credentials.json'))
  assert.equal(paths.configPath, path.join(tmpRoot, 'config.json'))
  assert.equal(paths.personaPath, path.join(tmpRoot, 'persona.md'))
  assert.equal(paths.pendingRepliesPath, path.join(tmpRoot, 'pending-replies.json'))
  assert.ok(!paths.WHALE_HOME.includes('.dsh'))
  assert.ok(!paths.WHALE_HOME.includes('.bili-ai'))
})

test('42 bundled stickers work out of the box without manual copy', () => {
  const list = listStickers()
  assert.equal(list.total, 42)
  assert.equal(list.items.length, 20)
  const happy = getSticker('开心')
  assert.equal(happy.name, '开心')
  assert.ok(fs.existsSync(happy.path))
  assert.ok(stickerHint().includes('bili_stickers'))
})

test('default models use Antigravity built-in flash + flash_lite', () => {
  const cfg = config({ fresh: true })
  assert.deepEqual(cfg.models, MODEL_DEFAULTS)
  assert.equal(cfg.models.main, 'flash')
  assert.equal(cfg.models.worker, 'flash_lite')
  assert.deepEqual(normalizeModels({ main: 'pro', worker: 'gemini-3.8-flash-high' }), {
    main: 'pro',
    worker: 'gemini-3.8-flash-high',
    minQuotaPercent: 0,
  })
  assert.deepEqual(normalizeModels({ main: 'bad model with spaces!', worker: '' }), MODEL_DEFAULTS)
})
