import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import test from 'node:test'
import assert from 'node:assert/strict'
import { applyPluginUpdate, checkForUpdate, readLocalPluginMeta } from '../lib/plugin-updater.js'
import { copyRuntimeFixture } from './fixtures/plugin-package.mjs'

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-plugin-install-test-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const pluginRoot = path.join(root, 'plugin')
  const whaleHome = path.join(root, 'data')
  fs.mkdirSync(whaleHome)
  fs.mkdirSync(path.join(pluginRoot, 'lib'), { recursive: true })
  fs.writeFileSync(path.join(pluginRoot, 'plugin.json'), JSON.stringify({ name: 'antigravity-bili-whale', version: '1.5.0' }))
  fs.writeFileSync(path.join(pluginRoot, 'lib', 'old.js'), 'old runtime')
  fs.writeFileSync(path.join(pluginRoot, 'local-note.txt'), 'keep local files')
  fs.writeFileSync(path.join(whaleHome, 'persona.md'), 'keep data')
  return { root, pluginRoot, whaleHome }
}

const mainSha = 'a'.repeat(40)
const tagObject = 'b'.repeat(40)
const releaseSha = 'c'.repeat(40)
const pkt = line => (Buffer.byteLength(line) + 4).toString(16).padStart(4, '0') + line
const mockFetch = async url => {
  if (url.endsWith('/main/plugin.json')) return Response.json({ name: 'antigravity-bili-whale', version: '1.5.0' })
  if (url.endsWith('/commits/main.atom')) return new Response(`<entry><id>Commit/${mainSha}</id></entry>`)
  if (url.endsWith('/releases/latest')) return new Response(null, { status: 302, headers: { location: '/release/repo/releases/tag/v1.5.0' } })
  if (url.endsWith('/info/refs?service=git-upload-pack')) {
    return new Response(pkt('# service=git-upload-pack\n') + '0000' + pkt('version 1\n')
      + pkt(`${mainSha} HEAD\0object-format=sha1\n`) + pkt(`${tagObject} refs/tags/v1.5.0\n`)
      + pkt(`${releaseSha} refs/tags/v1.5.0^{}\n`) + '0000')
  }
  if (url.endsWith(`/zip/${mainSha}`) || url.endsWith(`/zip/${releaseSha}`)) return new Response(Buffer.alloc(2048))
  throw new Error(`Unexpected fetch: ${url}`)
}

test('same-version changes compare against the installed tag commit and download the chosen main commit', async t => {
  const { pluginRoot, whaleHome } = fixture(t)
  const fetchImpl = mockFetch
  const extractZip = async (_zip, dir) => copyRuntimeFixture(dir, '1.5.0')
  const fromRelease = await applyPluginUpdate({ pluginRoot, whaleHome, fetchImpl, extractZip, ref: 'v1.5.0' })
  assert.equal(fromRelease.commitSha, releaseSha)
  assert.equal(readLocalPluginMeta({ pluginRoot, whaleHome }).installedTag, 'v1.5.0')

  const update = await checkForUpdate({ pluginRoot, whaleHome, fetchImpl })
  assert.equal(update.status, 'commit_available')
  assert.equal(update.remote.targetRef, 'main')
  const fromMain = await applyPluginUpdate({ pluginRoot, whaleHome, fetchImpl, extractZip, ref: update.remote.targetRef })
  assert.equal(fromMain.commitSha, mainSha)
  assert.equal((await checkForUpdate({ pluginRoot, whaleHome, fetchImpl })).status, 'up_to_date')
  assert.equal(fs.existsSync(path.join(pluginRoot, 'lib', 'old.js')), false)
  assert.equal(fs.readFileSync(path.join(pluginRoot, 'local-note.txt'), 'utf8'), 'keep local files')
  assert.equal(fs.readFileSync(path.join(whaleHome, 'persona.md'), 'utf8'), 'keep data')
})

test('incomplete packages and failed final switches leave the old installation intact', async t => {
  const { pluginRoot, whaleHome } = fixture(t)
  const input = { pluginRoot, whaleHome, fetchImpl: mockFetch }
  await assert.rejects(applyPluginUpdate({ ...input, extractZip: async (_zip, dir) => {
    copyRuntimeFixture(dir, '1.5.1')
    fs.unlinkSync(path.join(dir, 'lib', 'scheduler.js'))
  } }), /插件运行文件或目录缺失/)

  const rename = fs.renameSync
  t.mock.method(fs, 'renameSync', (from, to) => {
    if (path.basename(from) === 'new' && to === pluginRoot) throw Object.assign(new Error('simulated switch failure'), { code: 'EBUSY' })
    rename(from, to)
  })
  await assert.rejects(applyPluginUpdate({ ...input, extractZip: async (_zip, dir) => copyRuntimeFixture(dir, '1.5.1') }), /simulated switch failure/)
  assert.equal(readLocalPluginMeta({ pluginRoot, whaleHome }).version, '1.5.0')
  assert.equal(readLocalPluginMeta({ pluginRoot, whaleHome }).installedCommit, null)
  assert.equal(fs.readFileSync(path.join(pluginRoot, 'lib', 'old.js'), 'utf8'), 'old runtime')
  assert.equal(fs.readFileSync(path.join(whaleHome, 'persona.md'), 'utf8'), 'keep data')
})

test('clean deployment only installs the selected plugin and leaves a sibling plugin intact', t => {
  const { root, whaleHome } = fixture(t)
  const parent = path.join(root, '.gemini', 'config', 'plugins')
  fs.mkdirSync(path.join(parent, 'bili-whale'), { recursive: true })
  const sentinel = path.join(parent, 'bili-whale', 'local-note.txt')
  fs.writeFileSync(sentinel, 'untouched')
  const result = spawnSync(process.execPath, ['scripts/deploy-plugin.mjs'], {
    encoding: 'utf8', windowsHide: true,
    env: { ...process.env, USERPROFILE: root, HOME: root, BILI_WHALE_HOME: whaleHome, BILI_WHALE_CONFIG: path.join(whaleHome, 'config.json') },
  })
  assert.equal(result.status, 0, result.stderr || result.stdout)
  assert.equal(fs.readFileSync(sentinel, 'utf8'), 'untouched')
  const installed = path.join(parent, 'antigravity-bili-whale')
  assert.equal(fs.existsSync(path.join(installed, 'mcp', 'dist', 'app.html')), true)
  for (const relative of ['.git', 'node_modules', 'test', 'ui-src']) {
    assert.equal(fs.existsSync(path.join(installed, relative)), false, relative)
  }
})
