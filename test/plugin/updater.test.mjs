import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import test from 'node:test'
import assert from 'node:assert/strict'
import { applyPluginUpdate, checkForUpdate, readLocalPluginMeta } from '../../src/plugin/updater.mjs'
import { validatePluginPayload } from '../../src/plugin/install.mjs'
import { formatBeijingDate, packageRelease } from '../../scripts/package-release.mjs'
import { copyRuntimeFixture } from '../fixtures/plugin-package.mjs'

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-plugin-install-test-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const pluginRoot = path.join(root, 'plugin')
  const whaleHome = path.join(root, 'data')
  fs.mkdirSync(whaleHome)
  fs.mkdirSync(path.join(pluginRoot, 'src', 'daemon'), { recursive: true })
  fs.writeFileSync(path.join(pluginRoot, 'plugin.json'), JSON.stringify({ name: 'antigravity-bili-whale', version: '1.5.0' }))
  fs.writeFileSync(path.join(pluginRoot, 'src', 'daemon', 'old.mjs'), 'old runtime')
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
  assert.equal(fs.existsSync(path.join(pluginRoot, 'src', 'daemon', 'old.mjs')), false)
  assert.equal(fs.readFileSync(path.join(pluginRoot, 'local-note.txt'), 'utf8'), 'keep local files')
  assert.equal(fs.readFileSync(path.join(whaleHome, 'persona.md'), 'utf8'), 'keep data')
})

test('incomplete packages and failed final switches leave the old installation intact', async t => {
  const { pluginRoot, whaleHome } = fixture(t)
  const input = { pluginRoot, whaleHome, fetchImpl: mockFetch }
  await assert.rejects(applyPluginUpdate({ ...input, extractZip: async (_zip, dir) => {
    copyRuntimeFixture(dir, '1.5.1')
    fs.unlinkSync(path.join(dir, 'src', 'daemon', 'scheduler.mjs'))
  } }), /插件运行文件或目录缺失/)

  const rename = fs.renameSync
  t.mock.method(fs, 'renameSync', (from, to) => {
    if (path.basename(from) === 'new' && to === pluginRoot) throw Object.assign(new Error('simulated switch failure'), { code: 'EBUSY' })
    rename(from, to)
  })
  await assert.rejects(applyPluginUpdate({ ...input, extractZip: async (_zip, dir) => copyRuntimeFixture(dir, '1.5.1') }), /simulated switch failure/)
  assert.equal(readLocalPluginMeta({ pluginRoot, whaleHome }).version, '1.5.0')
  assert.equal(readLocalPluginMeta({ pluginRoot, whaleHome }).installedCommit, null)
  assert.equal(fs.readFileSync(path.join(pluginRoot, 'src', 'daemon', 'old.mjs'), 'utf8'), 'old runtime')
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
  assert.equal(fs.existsSync(path.join(installed, 'dist', 'app.html')), true)
  for (const relative of ['.git', 'node_modules', 'test', 'web', 'AGENTS.md']) {
    assert.equal(fs.existsSync(path.join(installed, relative)), false, relative)
  }
})

test('Windows directory handle lock on root rename falls back safely to in-place sync', async t => {
  const { pluginRoot, whaleHome } = fixture(t)
  const rename = fs.renameSync
  t.mock.method(fs, 'renameSync', (from, to) => {
    if (path.resolve(from) === path.resolve(pluginRoot) && path.basename(to) === 'previous') {
      throw Object.assign(new Error('simulated Windows directory watcher lock'), { code: 'EPERM' })
    }
    rename(from, to)
  })
  const updated = await applyPluginUpdate({
    pluginRoot,
    whaleHome,
    fetchImpl: mockFetch,
    extractZip: async (_zip, dir) => copyRuntimeFixture(dir, '1.6.1'),
    ref: 'main',
  })
  assert.equal(updated.ok, true)
  assert.equal(updated.newVersion, '1.6.1')
  assert.equal(readLocalPluginMeta({ pluginRoot, whaleHome }).version, '1.6.1')
  assert.equal(fs.existsSync(path.join(pluginRoot, 'src', 'daemon', 'old.mjs')), false)
  assert.equal(fs.readFileSync(path.join(pluginRoot, 'local-note.txt'), 'utf8'), 'keep local files')
  assert.equal(fs.readFileSync(path.join(whaleHome, 'persona.md'), 'utf8'), 'keep data')
})

test('packageRelease creates clean runtime ZIP with Beijing date and fixed antigravity-bili-whale root folder', t => {
  assert.equal(formatBeijingDate(new Date('2026-11-26T17:00:00Z')), '20261127')
  const expectedVersion = JSON.parse(fs.readFileSync(path.resolve('plugin.json'), 'utf8')).version
  const tmpOut = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-pkg-test-'))
  t.after(() => fs.rmSync(tmpOut, { recursive: true, force: true }))
  const pkg = packageRelease({
    outDir: tmpOut,
    now: new Date('2026-11-26T15:00:00Z'), // 2026-11-26 23:00 CST
    tag: `v${expectedVersion}`,
    commitSha: 'a'.repeat(40),
  })
  assert.equal(pkg.zipName, `antigravity-bili-whale-v${expectedVersion}-20261126.zip`)
  assert.equal(pkg.folderName, 'antigravity-bili-whale')
  assert.equal(fs.existsSync(pkg.zipPath), true)
  assert.ok(pkg.size > 10_000)

  const unzipDir = path.join(tmpOut, 'unzipped')
  fs.mkdirSync(unzipDir)
  if (process.platform === 'win32') {
    const tarExe = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe')
    const r = spawnSync(fs.existsSync(tarExe) ? tarExe : 'tar.exe', ['-x', '-f', pkg.zipPath, '-C', unzipDir], { windowsHide: true, encoding: 'utf8' })
    assert.equal(r.status, 0, r.stderr)
  } else {
    const r = spawnSync('unzip', ['-q', pkg.zipPath, '-d', unzipDir], { encoding: 'utf8' })
    assert.equal(r.status, 0, r.stderr)
  }
  assert.deepEqual(fs.readdirSync(unzipDir), ['antigravity-bili-whale'])
  const inner = path.join(unzipDir, 'antigravity-bili-whale')
  const manifest = validatePluginPayload(inner)
  assert.equal(manifest.version, expectedVersion)
  for (const excluded of ['.git', 'node_modules', 'test', 'web', 'scripts', 'AGENTS.md']) {
    assert.equal(fs.existsSync(path.join(inner, excluded)), false, `${excluded} must not be in release zip`)
  }
})
