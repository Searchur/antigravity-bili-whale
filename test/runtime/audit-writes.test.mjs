import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync, spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { execFileSync } from '../../src/core/capture.mjs'
import { saveCoverImage } from '../../src/media/cover-image.mjs'

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-write-test-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const file = (...parts) => path.join(dir, ...parts)
  fs.writeFileSync(file('config.json'), JSON.stringify({ self: { mid: '101' }, owner: { mid: '202' },
    safety: { mode: 'local_only' }, chat: { autoComment: true, dynamic: true }, risk: { minGapMs: 0, writeGapSec: 1 } }))
  fs.writeFileSync(file('credentials.json'), JSON.stringify({ sessdata: 'fixture', bili_jct: '0'.repeat(32), buvid3: 'fixture' }))
  const preload = new URL('../fixtures/audit-platform.mjs', import.meta.url).href
  const env = { ...process.env, BILI_WHALE_HOME: dir, BILI_WHALE_CONFIG: file('config.json'), NODE_OPTIONS: '--import "' + preload + '"' }
  const root = fileURLToPath(new URL('../..', import.meta.url))
  const cli = (...args) => {
    const r = spawnSync(process.execPath, ['src/cli/bili.mjs', ...args], { cwd: root, env, encoding: 'utf8', timeout: 15000 })
    if (r.error) throw r.error
    return r
  }
  fs.mkdirSync(file('shots'))
  const pic = file('shots', 'sample.png')
  fs.copyFileSync(path.join(root, 'assets', 'logo.png'), pic)
  const calls = () => fs.readFileSync(file('calls.log'), 'utf8').trim().split('\n')
  return { file, pic, cli, calls, env, root }
}

test('D15 a freshly uploaded comment picture waits for the write gap and reaches reply/add', t => {
  const { cli, pic, calls } = fixture(t)
  const args = ['comment', '--auto', '--oid', '100', '--bvid', 'BV0000000001', '--message', 'fixture picture', '--pic', pic]
  assert.equal(cli(...args, '--dry').status, 0)
  const sent = cli(...args, '--go')
  assert.equal(calls().filter(p => p.endsWith('/upload_bfs')).length, 1)
  assert.equal(calls().filter(p => p.endsWith('/reply/add')).length, 1, sent.stderr)
})

test('D16 a rejected dynamic can use the same uploaded picture with revised text', t => {
  const { cli, pic, calls } = fixture(t)
  for (const text of ['fixture one', 'fixture two']) {
    const args = ['dynamic-image', '--image', pic, '--text', text]
    assert.equal(cli(...args, '--dry').status, 0)
    cli(...args, '--go')
  }
  assert.equal(calls().filter(p => p.endsWith('/upload_bfs')).length, 1)
  assert.equal(calls().filter(p => p.endsWith('/create/dyn')).length, 2)
})

test('D19 claims need explicit confirmation and preserve a concurrent insertion before the selected index', t => {
  const { cli, file } = fixture(t)
  const ledger = file('favorites.json')
  const initial = { items: [{ bv: 'oldA' }, { bv: 'oldB' }] }
  fs.writeFileSync(ledger, JSON.stringify(initial))
  assert.notEqual(cli('fav', '--claim-legacy', '1').status, 0)
  assert.deepEqual(JSON.parse(fs.readFileSync(ledger)), initial)
  const claim = cli('fav', '--claim-legacy', '1', '--go')
  assert.equal(claim.status, 0, claim.stderr)
  assert.deepEqual(JSON.parse(fs.readFileSync(ledger)).items.map(x => [x.bv, x.account]), [['concurrent','101'],['oldA',undefined],['oldB','101']])
})

test('D24 HTTP error bodies cannot replace an existing cover', t => {
  const { cli, file } = fixture(t)
  fs.mkdirSync(file('shots','covers'))
  const target = file('shots','covers','BV0000000001.jpg')
  fs.writeFileSync(target, 'previous')
  assert.notEqual(cli('covers', 'BV0000000001').status, 0)
  assert.equal(fs.readFileSync(target, 'utf8'), 'previous')
})

test('D25 capture enforces the byte limit for each stream and stops a child before later work', t => {
  const { file } = fixture(t)
  for (const stream of ['stdout', 'stderr']) {
    const marker = file(stream + '-finished')
    const pidFile = file(stream + '-pid')
    const script = 'const fs=require("node:fs"); fs.writeFileSync(process.argv[2],String(process.pid)); process.' + stream
      + '.write("123456789"); setTimeout(() => fs.writeFileSync(process.argv[1],"finished"),300)'
    assert.throws(() => execFileSync(process.execPath, ['-e', script, marker, pidFile], { maxBuffer: 8 }), { code: 'ENOBUFS' })
    assert.throws(() => process.kill(Number(fs.readFileSync(pidFile,'utf8')), 0), {code:'ESRCH'})
    assert.equal(fs.existsSync(marker),false)
  }
  assert.equal(execFileSync(process.execPath, ['-e','process.stdout.write("12345678")'], { encoding: 'utf8', maxBuffer: 8 }), '12345678')
  assert.equal(execFileSync(process.execPath, ['-e','process.stdout.write("123456");process.stderr.write("abcdef")'], { encoding: 'utf8', maxBuffer: 8 }), '123456')
  assert.throws(() => execFileSync(process.execPath,['-e','process.stdout.write("海");process.stderr.write("岸");process.exitCode=3'], {encoding:'utf8',maxBuffer:3}),
    error => error.status === 3 && error.stdout === '海' && error.stderr === '岸')
  assert.throws(() => execFileSync(process.execPath,['-e','setTimeout(()=>{},5000)'], {timeout:100,maxBuffer:8}), {code:'ETIMEDOUT'})
})

test('D24 validate decoded pixels before replacing a cached cover', async t => {
  const { pic, file } = fixture(t)
  const valid = fs.readFileSync(pic), target = file('cached.jpg')
  await saveCoverImage(new Response(valid), target)
  for (const broken of [valid.subarray(0, 18), Buffer.from('<html>unavailable</html>')]) {
    await assert.rejects(saveCoverImage(new Response(broken), target))
    assert.deepEqual(fs.readFileSync(target), valid)
  }
})

test('D18 concurrent quota records merge and duplicate operation IDs count once', async t => {
  const { env, root, file } = fixture(t)
  function append(id) {
    return new Promise((resolve, reject) => {
      const child = spawn(process.execPath, ['src/cli/commands/quota.mjs', 'record', '--type', 'comment', '--operation', id], { cwd: root, env, stdio: 'ignore' })
      child.on('error', reject)
      child.on('exit', code => code === 0 ? resolve() : reject(Error('quota exit ' + code)))
    })
  }
  await Promise.all(['a','b','c','a','b','d','e','f'].map(append))
  const log = JSON.parse(fs.readFileSync(file('quota.json'))).log
  assert.equal(log.length, 6)
  assert.deepEqual(log.map(row => row.operationId).sort(), ['a','b','c','d','e','f'])
})

test('D17 a confirmed post with failed accounting is recovered once without resending', t => {
  const { cli, file, calls } = fixture(t)
  const args = ['dynamic', 'post', '--text', 'fixture accounting']
  assert.equal(cli(...args, '--dry').status, 0)
  fs.writeFileSync(file('fail-accounting'), '')
  const posted = cli(...args, '--go')
  assert.match(posted.stderr, /已.*(接受|发送|发布).*补账/)
  assert.equal(fs.readFileSync(file('quota.json'), 'utf8'), 'unreadable ledger')
  const settings = JSON.parse(fs.readFileSync(file('config.json')))
  settings.owner.mid = '303'
  fs.writeFileSync(file('config.json'), JSON.stringify(settings))
  fs.writeFileSync(file('quota.json'), '{"log":[]}')
  for (let i = 0; i < 2; i++) assert.equal(cli('quota', 'status').status, 0)
  const { log } = JSON.parse(fs.readFileSync(file('quota.json')))
  assert.equal(log.length, 1)
  assert.equal(log[0].target, 'dynamic:501')
  assert.equal(calls().filter(p => p.endsWith('/create/dyn')).length, 1)
})

