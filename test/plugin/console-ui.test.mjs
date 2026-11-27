import test from 'node:test'
import assert from 'node:assert/strict'
import { openConsole } from '../fixtures/console-ui.mjs'
import fs from 'node:fs'
import { chatConfig } from '../../src/config/chat.mjs'
import { deriveActivityStatus } from '../../src/shared/activity-status.mjs'

test('D07 late bootstrap cannot reinstate the old account after QR login succeeds', async t => {
  const previous = {settings:{config:{self:{mid:'100'},owner:{mid:'200'},preferences:{},night:{}}},status:{}}
  const loading = Promise.withResolvers(), loggedIn = Promise.withResolvers()
  let loads = 0
  const ui = await openConsole(t, (name, args) => {
    if (name === 'whale_app_bootstrap') return ++loads === 1 ? structuredClone(previous) : loading.promise
    if (args.action === 'qr_start') return {id:'offline', status:'waiting'}
    if (args.action === 'qr_poll') { loggedIn.resolve(); return {status:'success',account:{mid:'333',name:'new account'}} }
  })
  await ui.click('重新扫码')
  assert.equal(ui.button('重新读取').disabled,false)
  const reload = ui.click('重新读取')
  await loggedIn.promise
  await new Promise(setImmediate)
  assert.equal(ui.input('扫码后自动获取').value,'333')
  loading.resolve(previous)
  await reload
  assert.equal(ui.input('扫码后自动获取').value,'333')
})

test('D07 changing the saved owner clears cached experiences and discards late search results', async t => {
  let delayed = false
  const pending = Promise.withResolvers()
  const ui = await openConsole(t, (name, args) => {
    if (name === 'whale_app_life' && args.action === 'search') {
      const result = { result: [{ text: 'old owner memory' }] }
      return delayed ? pending.promise.then(() => result) : result
    }
  })
  ui.click('动态与记忆')
  await new Promise(setImmediate)
  await ui.click('搜索')
  assert.match(ui.root.textContent, /old owner memory/)
  delayed = true
  const oldSearch = ui.click('搜索')
  ui.click('大鲸鱼与主人')
  ui.change(ui.input('例如 12345678'), '444')
  await ui.click('保存配置')
  ui.click('动态与记忆')
  await new Promise(setImmediate)
  assert.doesNotMatch(ui.root.textContent, /old owner memory/)
  pending.resolve()
  await oldSearch
  assert.doesNotMatch(ui.root.textContent, /old owner memory/)
})

test('D26 late owner verification cannot apply a nickname to another UID', async t => {
  const pending = Promise.withResolvers()
  const ui = await openConsole(t, (_, args) => args.action === 'verify_owner' ? pending.promise : undefined)
  ui.change(ui.input('例如 12345678'), '111')
  const lookup = ui.click('检查 UID')
  ui.change(ui.input('例如 12345678'), '222')
  pending.resolve({ matched: false, actualName: 'old name', detail: 'old' })
  await lookup
  assert.equal(ui.button('同步为'), undefined)
})

test('D27 edits typed during save remain dirty and survive the response', async t => {
  const pending = Promise.withResolvers()
  const ui = await openConsole(t, (name, args) => {
    if (name !== 'whale_app_settings') return
    const snapshot = structuredClone(args.config)
    return pending.promise.then(() => ({ config: snapshot }))
  })
  ui.change(ui.input('例如 12345678'), '222')
  const save = ui.click('保存配置')
  ui.change(ui.input('例如 12345678'), '333')
  pending.resolve()
  await save
  assert.equal(ui.input('例如 12345678').value, '333')
  assert.match(ui.root.textContent, /有未保存更改/)
})

test('D31 typing or clearing an owner UID toggles verification without replacing the input', async t => {
  const ui = await openConsole(t)
  const field = ui.input('例如 12345678'), verify = ui.button('检查 UID')
  assert.equal(verify.disabled, true)
  ui.change(field, '111')
  assert.equal(verify.disabled, false)
  assert.equal(ui.input('例如 12345678'), field)
  ui.change(field, ' ')
  assert.equal(verify.disabled, true)
})

test('D32 typing in the receipt field keeps the input node and updates confirmation', async t => {
  const ui = await openConsole(t)
  ui.click('动态与记忆')
  await new Promise(setImmediate)
  const verified = ui.root.nodes().find(n => n.tag === 'input' && n.attrs.type === 'checkbox')
  verified.events.change({ target: { checked: true } })
  const receipt = ui.input('已发出请填回执 ID')
  for (const value of ['1','12','']) {
    ui.change(receipt, value)
    assert.equal(ui.input('已发出请填回执 ID') === receipt, true)
    assert.equal(ui.button('确认已发出').disabled, !value)
  }
})

test('D34 first-use instructions reflect the configured auto-comment default', () => {
  const readme = fs.readFileSync(new URL('../../README.md', import.meta.url), 'utf8')
  const mode = chatConfig({}).autoComment ? '开启' : '关闭'
  assert.ok(readme.includes('自主评论默认' + mode))
  assert.match(readme, /主动浏览默认关闭/)
})

test('deriveActivityStatus enforces strict single-badge priority without conflicting states', () => {
  const baseCfg = {
    self: { mid: '100', name: '大鲸鱼' },
    owner: { mid: '200', name: '主人' },
    browse: { enabled: true },
    listen: { dmOwner: false, dmFan: false, commentOwner: false, commentFan: false },
  }
  const lowQuota = { enabled: true, paused: true, remainingPercent: 17.17, threshold: 20 }

  // 1. Missing identity + low quota: never shows 正常运行中 or 暂停主动活动
  const unconfigured = deriveActivityStatus({
    savedConfig: { self: { mid: '' }, owner: { mid: '' } },
    status: { sidecarRunning: true, modelQuota: lowQuota },
    life: { paused: false },
  })
  assert.equal(unconfigured.code, 'identity_missing')
  assert.equal(unconfigured.badge.text, '未绑定账号与主人')
  assert.equal(unconfigured.primaryAction.type, 'goto_tab')
  assert.equal(unconfigured.primaryAction.tab, 'account')
  assert.match(unconfigured.notice.text, /17\.17% < 20%/)

  // 1b. Unsaved owner draft gives save prompt
  const unsavedOwner = deriveActivityStatus({
    savedConfig: { self: { mid: '100' }, owner: { mid: '' } },
    draftConfig: { self: { mid: '100' }, owner: { mid: '200' } },
    status: { sidecarRunning: true },
    life: { paused: false },
  })
  assert.equal(unsavedOwner.code, 'identity_missing')
  assert.equal(unsavedOwner.badge.text, '尚未配置主人 UID')
  assert.match(unsavedOwner.notice.text, /保存配置/)

  // 2. Sidecar offline
  const offline = deriveActivityStatus({
    savedConfig: baseCfg,
    status: { sidecarRunning: false, modelQuota: lowQuota },
    life: { paused: true },
  })
  assert.equal(offline.code, 'sidecar_offline')
  assert.equal(offline.badge.text, '后台守护未运行')
  assert.equal(offline.primaryAction.tab, 'env')
  assert.equal(offline.secondaryAction.label, '恢复主动活动')

  // 3. Both manual pause and quota pause
  const both = deriveActivityStatus({
    savedConfig: baseCfg,
    status: { sidecarRunning: true, modelQuota: lowQuota },
    life: { paused: true },
  })
  assert.equal(both.code, 'paused_both')
  assert.equal(both.badge.text, '已暂停（手动 + 配额保护）')
  assert.equal(both.primaryAction.label, '恢复主动活动')
  assert.equal(both.secondaryAction.label, '调整配额保护')

  // 4. Quota pause only: no 正常运行中 and no 暂停主动活动
  const quotaOnly = deriveActivityStatus({
    savedConfig: baseCfg,
    status: { sidecarRunning: true, modelQuota: lowQuota },
    life: { paused: false },
  })
  assert.equal(quotaOnly.code, 'paused_quota')
  assert.equal(quotaOnly.badge.text, '配额保护已暂停（剩余 17.17% < 20%）')
  assert.equal(quotaOnly.primaryAction.type, 'goto_tab')
  assert.equal(quotaOnly.primaryAction.tab, 'models')
  assert.equal(quotaOnly.secondaryAction, null)

  // 5. Manual pause only
  const manualOnly = deriveActivityStatus({
    savedConfig: baseCfg,
    status: { sidecarRunning: true, modelQuota: { enabled: true, paused: false, remainingPercent: 80, threshold: 20 } },
    life: { paused: true },
  })
  assert.equal(manualOnly.code, 'paused_manual')
  assert.equal(manualOnly.badge.text, '主动活动已手动暂停')
  assert.equal(manualOnly.primaryAction.label, '恢复主动活动')

  // 6. Ready but all auto toggles disabled -> standby
  const standby = deriveActivityStatus({
    savedConfig: { ...baseCfg, browse: { enabled: false } },
    status: { sidecarRunning: true, modelQuota: { enabled: true, paused: false, remainingPercent: 80, threshold: 20 } },
    life: { paused: false },
  })
  assert.equal(standby.code, 'standby')
  assert.equal(standby.badge.text, '已就绪 · 待命中')
  assert.equal(standby.primaryAction.label, '暂停主动活动')

  // 7. Ready and auto enabled -> running
  const running = deriveActivityStatus({
    savedConfig: baseCfg,
    status: { sidecarRunning: true, modelQuota: { enabled: true, paused: false, remainingPercent: 80, threshold: 20 } },
    life: { paused: false },
  })
  assert.equal(running.code, 'running')
  assert.equal(running.badge.text, '正常运行中')
  assert.equal(running.notice, null)
  assert.equal(running.primaryAction.label, '暂停主动活动')
})

test('Memory tab never shows conflicting running/quota-paused/pause-button/storage-error together', async t => {
  const lowQuotaStatus = {
    sidecarRunning: true,
    modelQuota: { enabled: true, paused: true, remainingPercent: 17.17, threshold: 20 },
  }

  // Case A: Missing owner + low quota (screenshot repro)
  const uiUnbound = await openConsole(t, (name, args) => {
    if (name === 'whale_app_bootstrap') {
      return {
        settings: { config: { self: { mid: '100', name: '鲸鱼' }, owner: { mid: '', name: '' }, preferences: {}, night: {} } },
        status: lowQuotaStatus,
      }
    }
    if (name === 'whale_app_ops' && args.action === 'status') return lowQuotaStatus
    if (name === 'whale_app_life' && args.action === 'status') return { state: { paused: false, events: 0, memories: [], pending: [] } }
  })
  uiUnbound.click('动态与记忆')
  await new Promise(setImmediate)
  assert.match(uiUnbound.root.textContent, /尚未配置主人 UID/)
  assert.doesNotMatch(uiUnbound.root.textContent, /正常运行中/)
  assert.doesNotMatch(uiUnbound.root.textContent, /长期状态写入需要明确账号和主人/)
  assert.equal(uiUnbound.button('暂停主动活动'), undefined)
  assert.ok(uiUnbound.button('前往配置账号与主人'))

  // Case B: Bound identity + quota pause -> single quota badge & 调整配额保护, no 正常运行中 / 暂停主动活动
  const uiQuota = await openConsole(t, (name, args) => {
    if (name === 'whale_app_bootstrap') {
      return {
        settings: { config: { self: { mid: '100', name: '鲸鱼' }, owner: { mid: '200', name: '主人' }, browse: { enabled: true }, preferences: {}, night: {} } },
        status: lowQuotaStatus,
      }
    }
    if (name === 'whale_app_ops' && args.action === 'status') return lowQuotaStatus
    if (name === 'whale_app_life' && args.action === 'status') return { state: { paused: false, events: 0, memories: [], pending: [] } }
  })
  uiQuota.click('动态与记忆')
  await new Promise(setImmediate)
  assert.match(uiQuota.root.textContent, /配额保护已暂停（剩余 17\.17% < 20%）/)
  assert.doesNotMatch(uiQuota.root.textContent, /正常运行中/)
  assert.equal(uiQuota.button('暂停主动活动'), undefined)
  assert.ok(uiQuota.button('调整配额保护'))

  // Case C: Bound identity + both manual pause & quota pause -> resume transitions to quota-only cleanly
  let pausedFlag = true
  const uiBoth = await openConsole(t, (name, args) => {
    if (name === 'whale_app_bootstrap') {
      return {
        settings: { config: { self: { mid: '100', name: '鲸鱼' }, owner: { mid: '200', name: '主人' }, browse: { enabled: true }, preferences: {}, night: {} } },
        status: lowQuotaStatus,
      }
    }
    if (name === 'whale_app_ops' && args.action === 'status') return lowQuotaStatus
    if (name === 'whale_app_life' && args.action === 'status') return { state: { paused: pausedFlag, events: 0, memories: [], pending: [] } }
    if (name === 'whale_app_life' && args.action === 'pause') {
      pausedFlag = Boolean(args.params?.value)
      return { state: { paused: pausedFlag, events: 0, memories: [], pending: [] } }
    }
  })
  uiBoth.click('动态与记忆')
  await new Promise(setImmediate)
  assert.match(uiBoth.root.textContent, /已暂停（手动 \+ 配额保护）/)
  assert.ok(uiBoth.button('恢复主动活动'))
  assert.ok(uiBoth.button('调整配额保护'))
  await uiBoth.click('恢复主动活动')
  await new Promise(setImmediate)
  assert.match(uiBoth.root.textContent, /配额保护已暂停（剩余 17\.17% < 20%）/)
  assert.equal(uiBoth.button('恢复主动活动'), undefined)
  assert.equal(uiBoth.button('暂停主动活动'), undefined)

  // Case D: Pause error stays inside activity card and never leaks into memory card
  const uiErr = await openConsole(t, (name, args) => {
    if (name === 'whale_app_bootstrap') {
      return {
        settings: { config: { self: { mid: '100', name: '鲸鱼' }, owner: { mid: '200', name: '主人' }, browse: { enabled: true }, preferences: {}, night: {} } },
        status: { sidecarRunning: true, modelQuota: { enabled: true, paused: false, remainingPercent: 80, threshold: 20 } },
      }
    }
    if (name === 'whale_app_ops' && args.action === 'status') return { sidecarRunning: true, modelQuota: { enabled: true, paused: false, remainingPercent: 80, threshold: 20 } }
    if (name === 'whale_app_life' && args.action === 'status') return { state: { paused: false, events: 0, memories: [], pending: [] } }
    if (name === 'whale_app_life' && args.action === 'pause') throw new Error('模拟暂停失败')
  })
  uiErr.click('动态与记忆')
  await new Promise(setImmediate)
  assert.match(uiErr.root.textContent, /正常运行中/)
  await uiErr.click('暂停主动活动')
  const cards = uiErr.root.nodes().filter(n => n.className === 'card')
  assert.equal(cards.length, 2)
  assert.match(cards[0].textContent, /模拟暂停失败/)
  assert.doesNotMatch(cards[1].textContent, /模拟暂停失败/)
})

