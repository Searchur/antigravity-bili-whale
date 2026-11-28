/**
 * 控制台 UI 交互与状态机回归测试：覆盖登录竞态、主人核验、活动状态机与报错隔离。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { openConsole } from '../fixtures/console-ui.mjs'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { createTrafficGuard, RISK_DEFAULTS } from '../../src/bili/traffic.mjs'
import { chatConfig } from '../../src/config/chat.mjs'
import { createApiHandlers } from '../../src/console/api-handlers.mjs'
import { fallbackModelCatalog, normalizeModelCatalog } from '../../src/host/rpc.mjs'
import { deriveActivityStatus } from '../../src/shared/activity-status.mjs'

test('environment panel shows the triggering operations and how to recover from each request pause', async t => {
  const whaleHome = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-ui-traffic-'))
  const credFile = path.join(whaleHome, 'credentials.json')
  const biliMjs = path.join(whaleHome, 'offline-deps.mjs')
  fs.writeFileSync(credFile, JSON.stringify({ sessdata: 'fixture-session', bili_jct: 'a'.repeat(32) }))
  fs.writeFileSync(biliMjs, `
    globalThis.fetch = async () => { throw new Error('Network disabled in test') }
    await import(${JSON.stringify(new URL('../../src/cli/commands/deps.mjs', import.meta.url).href)})
  `)
  const api = createApiHandlers({
    whaleHome, credFile, biliMjs,
    cfgFile: path.join(whaleHome, 'config.json'),
    ipcClient: async () => ({ running: true, pid: process.pid }),
  })
  t.after(() => { api.dispose(); fs.rmSync(whaleHome, { recursive: true, force: true }) })

  const headers = { cookie: 'SESSDATA=fixture-session' }
  const guard = createTrafficGuard({
    directory: whaleHome,
    settings: () => ({ ...RISK_DEFAULTS, minGapMs: 0 }),
    transport: async url => url.includes('/reply/add')
      ? Response.json({ code: 12051 })
      : Response.json({ code: 10031 }, { headers: { 'Retry-After': '900' } }),
  })
  await guard.fetch('https://api.bilibili.com/x/v2/reply/add?sign=fixture-secret', { method: 'POST', headers })
  await guard.fetch('https://api.bilibili.com/x/v3/fav/resource/deal', { method: 'POST' })

  let depsRequest
  const ui = await openConsole(t, (name, args) => {
    if (name === 'whale_app_ops' && args.action === 'deps') {
      depsRequest = api.checkDeps().then(report => ({ report }))
      return depsRequest
    }
  })
  ui.click('环境与依赖')
  await depsRequest
  await new Promise(setImmediate)

  const row = name => ui.root.nodes().find(node => node.className === 'env-row'
    && node.querySelector('.env-row-title')?.textContent === name)?.textContent ?? ''
  const traffic = () => row('全局防风控保护')
  assert.match(traffic(), /收藏视频.*10031/)
  assert.match(traffic(), /冷却至.*（本地时间）/)
  assert.match(traffic(), /发表评论或回复.*12051/)
  assert.match(traffic(), /需要人工处理.*核查并解除暂停/)
  assert.match(traffic(), /traffic resume --go/)
  assert.doesNotMatch(traffic(), /无需人工处理|fixture-secret|fixture-session/)
  assert.match(row('大鲸鱼 B 站登录状态'), /暂缓校验/)
  assert.doesNotMatch(row('大鲸鱼 B 站登录状态'), /尚未登录|前往登录/)

  const cli = fileURLToPath(new URL('../../src/cli/bili.mjs', import.meta.url))
  execFileSync(process.execPath, [cli, 'traffic', 'resume', '--go'], {
    env: { ...process.env, BILI_WHALE_HOME: whaleHome },
  })
  await ui.click('重新检测')
  assert.match(traffic(), /收藏视频.*10031/)
  assert.match(traffic(), /无需人工处理/)
  assert.doesNotMatch(traffic(), /12051/)
})

test('model picker only offers host choices and displays a depleted model as zero percent', async t => {
  const config = { models: { main: 'flash', worker: 'flash_lite', minQuotaPercent: 20 } }
  const offline = fallbackModelCatalog('暂未读取 Antigravity 模型清单。')
  const live = normalizeModelCatalog({
    groupedModels: {
      'gemini-4-neon': { displayName: 'Gemini 4 Neon', supportedThinkingLevels: [
        { thinkingSuffix: 'low', thinkingDisplayName: 'Low' },
        { thinkingSuffix: 'high', thinkingDisplayName: 'High' },
      ] },
    },
    clientModelConfigs: [
      { modelId: 'gemini-4-neon-high', quotaInfo: { remainingFraction: 1 } },
      { modelId: 'gemini-4-neon-low', quotaInfo: { resetTime: '2026-11-29T00:00:00Z' } },
      { modelId: 'no-quota', label: 'Unknown quota' },
    ],
  })
  let online = false
  let saved
  const ui = await openConsole(t, (name, args) => {
    if (name === 'whale_app_bootstrap') return { settings: { config }, models: offline, status: {} }
    if (name === 'whale_app_ops' && args.action === 'models') return online ? live : offline
    if (name === 'whale_app_settings') {
      saved = structuredClone(args.config)
      return { config: saved }
    }
  })
  ui.click('模型与配额')
  await new Promise(setImmediate)
  assert.doesNotMatch(ui.root.textContent, /自适应档位|自动档位|Flash（均衡）/)
  assert.equal(ui.root.nodes().filter(node => node.className?.startsWith('effort-btn')).length, 0)

  online = true
  await ui.click('刷新模型列表')
  assert.match(ui.root.textContent, /待选择实际模型/)
  assert.doesNotMatch(ui.root.textContent, /自适应档位|自动档位|Flash（均衡）/)
  const group = name => ui.root.nodes().find(node => node.className?.startsWith('model-group')
    && node.querySelector('.model-name')?.textContent === name)?.textContent ?? ''
  assert.match(group('Gemini 4 Neon'), /Low.*0%.*High.*100%/)
  assert.match(group('Unknown quota'), /配额未返回/)
  assert.doesNotMatch(group('Unknown quota'), /剩余 0%/)

  await ui.click('Low')
  assert.match(group('Gemini 4 Neon'), /剩余 0%/)
  assert.match(ui.root.textContent, /剩余配额 0% 低于保护阈值/)
  await ui.click('保存配置')
  assert.equal(saved.models.main, 'gemini-4-neon-low')
  assert.equal(saved.models.worker, 'flash_lite')
})

test('model picker shows only the current selection’s quota and refreshes protection after saving', async t => {
  const sonnet = 'claude-sonnet-5-5-medium'
  const carbon = 'gemini-4-carbon-medium'
  const config = { models: { main: sonnet, worker: sonnet, minQuotaPercent: 20 } }
  const catalog = normalizeModelCatalog({ clientModelConfigs: [
    { modelId: sonnet, label: 'Claude Sonnet 5.5 · Medium', quotaInfo: { remainingFraction: 1 } },
    { modelId: carbon, label: 'Gemini 4 Carbon · Medium', quotaInfo: { remainingFraction: 0 } },
  ] })
  const carbonPause = {
    selection: { main: sonnet, worker: carbon }, paused: true, modelId: carbon, threshold: 20,
    reason: '模型「Gemini 4 Carbon · Medium」剩余配额 0% 低于保护阈值 20%，已暂停全部后台活动。',
  }
  const earlierStatus = Promise.withResolvers()
  let statusRequests = 0
  let saved
  const ui = await openConsole(t, (name, args) => {
    if (name === 'whale_app_bootstrap') return { settings: { config }, models: catalog, status: { modelQuota: carbonPause } }
    if (name === 'whale_app_ops' && args.action === 'status') {
      return ++statusRequests === 1 ? earlierStatus.promise : { modelQuota: carbonPause }
    }
    if (name === 'whale_app_settings' && args.action === 'save') {
      saved = structuredClone(args.config)
      return { config: saved }
    }
  })
  ui.click('模型与配额')
  assert.doesNotMatch(ui.root.textContent, /已暂停全部后台活动|配额保护已暂停|个实时模型档位/)
  assert.equal(ui.root.querySelector('.model-section-title').textContent, '当前完整模型清单')

  ui.click('后台辅助模型')
  const carbonRow = ui.root.nodes().find(n => n.querySelector('.model-name')?.textContent === 'Gemini 4 Carbon · Medium'
    && n.className?.startsWith('model-group'))
  carbonRow.nodes().find(n => n.className?.startsWith('effort-btn')).events.click()
  assert.match(ui.root.textContent, /保存后将暂停全部后台活动/)
  assert.doesNotMatch(ui.root.textContent, /已暂停全部后台活动/)

  await ui.click('保存配置')
  await new Promise(setImmediate)
  assert.deepEqual(saved.models, { main: sonnet, worker: carbon, minQuotaPercent: 20 })
  assert.equal(statusRequests, 2)
  assert.match(ui.root.textContent, /Gemini 4 Carbon · Medium」剩余配额 0%.*已暂停全部后台活动/)

  earlierStatus.resolve({ modelQuota: { selection: { main: sonnet, worker: sonnet }, paused: false, modelId: sonnet, threshold: 20 } })
  await new Promise(setImmediate)
  assert.match(ui.root.textContent, /Gemini 4 Carbon · Medium」剩余配额 0%.*已暂停全部后台活动/)
})

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
  ui.click('账号与主人')
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
  const lookup = ui.click('核验主人信息')
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
  const field = ui.input('例如 12345678'), verify = ui.button('核验主人信息')
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

  // 1. 未绑定账号与主人且配额偏低：绝不显示「正常运行中」或「暂停主动活动」
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

  // 1b. 已填主人 UID 草稿但尚未保存时提示先点击「保存配置」
  const unsavedOwner = deriveActivityStatus({
    savedConfig: { self: { mid: '100' }, owner: { mid: '' } },
    draftConfig: { self: { mid: '100' }, owner: { mid: '200' } },
    status: { sidecarRunning: true },
    life: { paused: false },
  })
  assert.equal(unsavedOwner.code, 'identity_missing')
  assert.equal(unsavedOwner.badge.text, '尚未配置主人 UID')
  assert.match(unsavedOwner.notice.text, /保存配置/)

  // 2. Sidecar 后台守护离线
  const offline = deriveActivityStatus({
    savedConfig: baseCfg,
    status: { sidecarRunning: false, modelQuota: lowQuota },
    life: { paused: true },
  })
  assert.equal(offline.code, 'sidecar_offline')
  assert.equal(offline.badge.text, '后台守护未运行')
  assert.equal(offline.primaryAction.tab, 'env')
  assert.equal(offline.secondaryAction.label, '恢复主动活动')

  // 3. 手动暂停与配额保护同时生效
  const both = deriveActivityStatus({
    savedConfig: baseCfg,
    status: { sidecarRunning: true, modelQuota: lowQuota },
    life: { paused: true },
  })
  assert.equal(both.code, 'paused_both')
  assert.equal(both.badge.text, '已暂停（手动 + 配额保护）')
  assert.equal(both.primaryAction.label, '恢复主动活动')
  assert.equal(both.secondaryAction.label, '调整配额保护')

  // 4. 仅配额保护暂停：不显示「正常运行中」与「暂停主动活动」
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

  // 5. 仅手动暂停
  const manualOnly = deriveActivityStatus({
    savedConfig: baseCfg,
    status: { sidecarRunning: true, modelQuota: { enabled: true, paused: false, remainingPercent: 80, threshold: 20 } },
    life: { paused: true },
  })
  assert.equal(manualOnly.code, 'paused_manual')
  assert.equal(manualOnly.badge.text, '主动活动已手动暂停')
  assert.equal(manualOnly.primaryAction.label, '恢复主动活动')

  // 6. 一切就绪但自动开关全关：进入待命态
  const standby = deriveActivityStatus({
    savedConfig: { ...baseCfg, browse: { enabled: false } },
    status: { sidecarRunning: true, modelQuota: { enabled: true, paused: false, remainingPercent: 80, threshold: 20 } },
    life: { paused: false },
  })
  assert.equal(standby.code, 'standby')
  assert.equal(standby.badge.text, '已就绪 · 待命中')
  assert.equal(standby.primaryAction.label, '暂停主动活动')

  // 7. 一切就绪且开启自动开关：进入正常运行态
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

  // 场景 A：缺少主人 UID 且触发低配额保护（复现冲突场景）
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

  // 场景 B：已绑定身份且触发配额保护：仅展示配额暂停徽章与「调整配额保护」
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

  // 场景 C：手动暂停与配额保护叠加：解除手动暂停后平滑回落为配额保护态
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

  // 场景 D：暂停接口报错仅留在顶部活动卡片，不污染底部长期记忆卡片
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

