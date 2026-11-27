import test from 'node:test'
import assert from 'node:assert/strict'
import { openConsole } from '../fixtures/console-ui.mjs'
import fs from 'node:fs'
import { chatConfig } from '../../src/config/chat.mjs'

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

