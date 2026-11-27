/**
 * 外发配额占用、跨午夜归属、写间隔等待与已发出回执补记恢复单元测试。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-quota-recovery-'))
process.env.BILI_WHALE_HOME = dir
process.env.BILI_WHALE_CONFIG = path.join(dir, 'config.json')
const cfg = { self: { mid: '100' }, owner: { mid: '200' }, chat: { autoComment: true, autoCommentDailyMax: 1 } }
const save = value => fs.writeFileSync(process.env.BILI_WHALE_CONFIG, JSON.stringify(value))
save(cfg)
const { guardSend } = await import('../../src/social/send-guard.mjs')
const { createLifeStore } = await import('../../src/life/store.mjs')
const cli = fileURLToPath(new URL('../../src/cli/commands/quota.mjs', import.meta.url))
const request = { channel: 'comment', target: '1000', thread: '1:1000:top', scene: 'public-comment', text: 'fixture A', auto: true, quotaTarget: 'oid:1000' }
test.after(() => fs.rmSync(dir, { recursive: true, force: true }))

test('D18 an unconfirmed dispatch occupies quota until resolved; a verified rejection releases it', async () => {
  const guard = await guardSend(request)
  await guard.store.dispatch(guard.token, async () => ({}))
  const check = () => spawnSync(process.execPath, [cli,'check','--type','comment','--auto','--target','oid:2000'], { encoding: 'utf8' })
  assert.equal(check().status, 2)
  const status = spawnSync(process.execPath, [cli,'status'], { encoding: 'utf8' })
  assert.match(status.stdout, /共 0 条/)
  assert.match(status.stdout, /待核查/)
  await guard.store.settle(guard.token, {status:'not-sent', verified:true})
  assert.equal(check().status, 0)
})

test('D15 a manual comment rechecks its bound account before entering the transport', async () => {
  const guard = await guardSend({...request, auto:false, target:'3000', quotaTarget:'oid:3000', thread:'1:3000:top'})
  save({...cfg,self:{mid:'101'}})
  let calls = 0
  await assert.rejects(guard.store.dispatch(guard.token, async () => ++calls), /账号/)
  assert.equal(calls, 0)
})

test('D18 resolving a receipt after midnight charges the original dispatch day', async () => {
  let now = Date.parse('2026-11-26T23:59:00+08:00')
  const store = createLifeStore({ whaleHome: dir, account: '201', owner: '202', now: () => now })
  const token = await store.reserve(request)
  now += 30000
  await store.dispatch(token, async () => ({}))
  const dispatchedAt = now
  now += 90000
  await store.settle(token, { status:'sent', receipt:'fixture' })
  assert.equal(Date.parse(store.read().settings.quotaReceipts[0].at), dispatchedAt)
})

