import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { createSessionDelivery } from '../../src/daemon/session-delivery.mjs'
import { captureDeliveryIdentity, createScopedDelivery } from '../../src/daemon/scoped-delivery.mjs'
import { createAntigravitySessionController } from '../../src/host/antigravity-session.mjs'
import { readDeliveries, updateDelivery } from '../../src/daemon/delivery-state.mjs'
import { dmListenerScope } from '../../src/social/dm-listener-scope.mjs'
import { createLifeStore } from '../../src/life/store.mjs'
import { createModelToolRunner } from '../../src/mcp/model-tools.mjs'

const setup = t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-whale-identity-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  return dir
}
const cfg = (account, owner) => ({ self: { mid: account }, owner: { mid: owner }, listen: { dmOwner: true } })
const request = requestId => ({ requestId, content: [{ type: 'text', text: 'test fixture' }] })

test('switching owner between conversation lookup and send blocks the previous task', async t => {
  const dir = setup(t)
  let current = cfg('1001', '2001')
  let sent = 0
  const controller = createAntigravitySessionController({
    workDir: dir,
    rpc: {
      async createConversation() { return { conversation: { id: 'original-owner-conversation' } } },
      async getConversation() { current = cfg('1001', '2002'); return {} },
      async sendMessage() { sent++ },
    },
  })
  const delivery = createScopedDelivery({
    dshHome: dir, controller, config: () => current, persona: () => 'fixture', contextGeneration: () => 'test',
  })
  const identity = captureDeliveryIdentity(current)
  const task = id => ({ ...request(id), identity, memoryScene: 'private-reply' })
  await delivery.send(task('first'))
  await assert.rejects(delivery.send(task('second')), { code: 'DELIVERY_IDENTITY_CHANGED' })
  assert.throws(() => delivery.send(task('third')), { code: 'DELIVERY_IDENTITY_CHANGED' })
  assert.equal(sent, 0)
})

test('ambiguous host results are never retried and a changed main model creates the next conversation', async t => {
  const dir = setup(t)
  const models = []
  let model = 'flash'
  const controller = {
    async createAndPrompt(input) {
      models.push(input.model)
      if (models.length === 1) throw Object.assign(Error('mocked transport timeout'), { code: 'AGY_RPC_TIMEOUT' })
      return { sessionId: 'created-' + models.length }
    },
    async prompt() { assert.fail('changed model must rotate the existing host conversation') },
  }
  const delivery = createSessionDelivery({
    dshHome: dir, sessionId: 'initial', controller, config: () => ({ models: { main: model } }), persona: () => 'fixture',
  })
  await assert.rejects(delivery.send(request('uncertain')), { code: 'DELIVERY_UNCONFIRMED' })
  await assert.rejects(delivery.send(request('uncertain')), { code: 'DELIVERY_UNCONFIRMED' })
  assert.equal(readDeliveries(dir).find(row => row.requestId === 'uncertain').status, 'unconfirmed')
  updateDelivery(dir, 'legacy-timeout', {
    attempt: 'old', sessionId: 'old', status: 'failed', startedAt: Date.now(), updatedAt: Date.now(),
    error: 'Antigravity RPC CreateConversation 超时',
  })
  await assert.rejects(delivery.send(request('legacy-timeout')), { code: 'DELIVERY_UNCONFIRMED' })
  assert.deepEqual(models, ['flash'])
  await delivery.send(request('before-switch'))
  model = 'pro'
  await delivery.send(request('after-switch'))
  assert.deepEqual(models, ['flash', 'flash', 'pro'])
})

test('unscoped and other account DM records cannot be read or acknowledged as the current account', t => {
  const dir = setup(t)
  const cfgPath = path.join(dir, 'config.json')
  const account = cfg('1001', '2001')
  const message = { key: 'fixture', hit: true, receipt: randomUUID(), mid: '2001', text: 'private fixture' }
  const source = dmListenerScope(account, dir).stateFile
  fs.mkdirSync(path.dirname(source), { recursive: true })
  fs.writeFileSync(source, JSON.stringify({ pending: message, unconfirmed: [message] }))
  fs.writeFileSync(path.join(dir, 'dm-await-state.json'), JSON.stringify({ pending: message, unconfirmed: [message] }))
  fs.writeFileSync(cfgPath, JSON.stringify(account))
  const listener = (...args) => spawnSync(process.execPath, [path.resolve('src/cli/commands/dm-await.mjs'), ...args], {
    env: { ...process.env, BILI_WHALE_HOME: dir, BILI_WHALE_CONFIG: cfgPath }, encoding: 'utf8', windowsHide: true,
  })
  const hit = listener('--json', '--peek')
  assert.equal(hit.status, 0, hit.stderr)
  assert.equal(JSON.parse(hit.stdout).receipt, message.receipt)

  fs.writeFileSync(cfgPath, JSON.stringify(cfg('1002', '2001')))
  const list = listener('--list-unconfirmed')
  assert.equal(list.status, 0, list.stderr)
  assert.deepEqual(JSON.parse(list.stdout).items, [])
  const ack = listener('--ack', message.receipt)
  assert.equal(ack.status, 2, ack.stderr)
  assert.equal(JSON.parse(fs.readFileSync(source, 'utf8')).pending.receipt, message.receipt)
})

test('model tool can retrieve task-scoped memory but cannot read private or global state directly', async t => {
  const dir = setup(t)
  const cfgFile = path.join(dir, 'config.json')
  const store = createLifeStore({ dshHome: dir, account: '1001', owner: '2001' })
  const taskId = randomUUID()
  await store.captureContext(taskId, '', 'private-reply', 'mock-session', { sessionRole: 'private-main' })
  fs.writeFileSync(cfgFile, JSON.stringify(cfg('1001', '2001')))
  const taskFile = path.join(dir, 'request.json')
  fs.writeFileSync(taskFile, JSON.stringify({ taskId }))
  const invoke = createModelToolRunner({ whaleHome: dir, cfgFile })
  for (const args of [['status'], ['export'], ['context', '', 'private'], ['search', '', '--private']]) {
    assert.equal((await invoke('bili_read', { command: 'life', args })).isError, true)
  }
  assert.equal((await invoke('bili_write', { command: 'dm-await', args: ['--peek'] })).isError, true)
  assert.equal((await invoke('bili_write', { command: 'dm-batch', args: ['--status'] })).isError, true)
  const authorized = await invoke('bili_read', { command: 'life', args: ['memory-catalog', taskFile, 'private-reply'] })
  assert.equal(authorized.isError, false, authorized.content[0].text)
  const otherScope = await invoke('bili_read', { command: 'life', args: ['memory-catalog', taskFile, 'private-recommendation'] })
  assert.equal(otherScope.isError, true)
})
