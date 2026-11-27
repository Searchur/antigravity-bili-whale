/**
 * 策略与防回归集成测试：覆盖只读约束、主动补话解耦、安全闭环、动态路由与损坏自愈。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { createMcpRouter } from '../../src/mcp/server.mjs'
import { createModelToolRunner } from '../../src/mcp/model-tools.mjs'
import { createApiHandlers } from '../../src/console/api-handlers.mjs'
import { createAffectWorker, createAffectSend } from '../../src/daemon/affect-worker.mjs'
import { buildActivityCalendar } from '../../src/console/activity-stats.mjs'
import { createJsonCache } from '../../src/core/json-cache.mjs'
import { startScheduler } from '../../src/daemon/scheduler.mjs'
import { lifeStore } from '../../src/life/runtime.mjs'
import { chatOpportunity } from '../../src/affect/chat-opportunity.mjs'
import { checkLocalSafety, enforceOutboundSafety } from '../../src/social/content-safety.mjs'
import { isFollowerOfWhale, clearRelationCache } from '../../src/bili/relation.mjs'
import { planIntervalFrames } from '../../src/media/watch-options.mjs'
import { pipelineConfig } from '../../src/cli/pipeline/config.mjs'
import { recordFanReply } from '../../src/social/fan-quota.mjs'
import { dmListenerScope } from '../../src/social/dm-listener-scope.mjs'

const exec = promisify(execFile)
const cli = fileURLToPath(new URL('../../src/cli/bili.mjs', import.meta.url))

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-review-reg-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const cfgFile = path.join(dir, 'config.json')
  const env = { ...process.env, BILI_WHALE_HOME: dir, BILI_WHALE_CONFIG: cfgFile }
  return { dir, cfgFile, env }
}

test('MCP model & app tools enforce read-only traffic/config and reject retired commands (Q4/Q5/Q7/Q9)', async t => {
  const { dir, cfgFile } = fixture(t)
  const api = createApiHandlers({
    whaleHome: dir,
    cfgFile,
    credFile: path.join(dir, 'credentials.json'),
    personaFile: path.join(dir, 'persona.md'),
    ipcClient: async () => ({ running: false }),
    rpc: { available: () => false },
  })
  const runner = createModelToolRunner({ whaleHome: dir, cfgFile })
  const router = createMcpRouter({ api, modelRunner: runner })
  t.after(() => router.dispose())

  // whale_app_life 动作枚举与 Tab 6 UI 严格对齐
  const listRes = await router.handleRequest({ jsonrpc: '2.0', id: 1, method: 'tools/list' })
  const lifeTool = listRes.result.tools.find(x => x.name === 'whale_app_life')
  assert.deepEqual(lifeTool.inputSchema.properties.action.enum, ['status', 'pause', 'search', 'export', 'resolve'])

  // traffic 命令仅开放只读 status 查询
  const badTraffic = await runner('bili_read', { command: 'traffic', args: ['resume'] })
  assert.equal(badTraffic.isError, true)
  assert.match(badTraffic.content[0].text, /管理数据请在控制台查看|traffic status/)

  // config 命令仅开放只读 show 查询
  const badConfig = await runner('bili_read', { command: 'config', args: ['set', 'deepReadMax', '5'] })
  assert.equal(badConfig.isError, true)
  assert.match(badConfig.content[0].text, /管理数据请在控制台查看|config show/)

  // 已下线命令及跨读写通道命令一律拒绝
  for (const [tool, command] of [
    ['bili_read', 'video'],
    ['bili_read', 'ai-share'],
    ['bili_read', 'expression'],
    ['bili_read', 'corpus'],
    ['bili_read', 'comment'],
    ['bili_read', 'dm'],
    ['bili_write', 'dynamic-edit'],
    ['bili_write', 'debrief'],
  ]) {
    const res = await runner(tool, { command, args: [] })
    assert.equal(res.isError, true, `${tool}:${command} should be rejected`)
  }

  // 已下线 behavior reload 子命令
  const badReload = await runner('bili_read', { command: 'behavior', args: ['reload'] })
  assert.equal(badReload.isError, true)
})

test('Q1 chat.followup works decoupled from autonomy/share/quiet-hours and never sends unsolicited idle DMs', async t => {
  const { dir } = fixture(t)
  const baseAt = Date.parse('2026-11-26T02:00:00+08:00') // 02:00 (previously blocked by quiet hours!)
  let clock = baseAt
  const cfg = {
    self: { mid: '100', name: '大鲸鱼' },
    owner: { mid: '300', name: '主人' },
    life: { enabled: true, autonomy: false, paused: false },
    share: { enabled: false, via: 'comment' },
    listen: { dmOwner: true, dmFan: false },
    chat: { followup: true, dynamic: false },
  }
  const store = lifeStore(cfg, { whaleHome: dir, fullConfig: () => cfg, now: () => clock })

  // 无已开启私信对话时绝不主动发送空闲私信
  assert.equal(chatOpportunity(store.read(), cfg, clock), null)

  // 主人发来私信并完成首轮回复后，即使关闭主动开关且处于凌晨，单次补话仍可独立触发
  await store.ingestOwnerMessage({
    text: '我明天去面试，有点紧张',
    actor: '300',
    messageId: 'dm-1',
    channel: 'bili-dm',
  })
  clock += 60_000
  const firstTok = await store.reserve({ channel: 'dm', target: '300', text: '加油，早点休息呀', auto: false, scene: 'private-reply' })
  await store.dispatch(firstTok, () => {})
  await store.settle(firstTok, { status: 'sent', receipt: 'dm-reply-1' })

  clock += 60_000
  const opp = chatOpportunity(store.read(), cfg, clock)
  assert.ok(opp, 'followup opportunity should trigger after owner DM + reply')
  assert.equal(opp.kind, 'followup')

  // 关闭 chat.followup 或 listen.dmOwner 后立即禁用补话
  assert.equal(chatOpportunity(store.read(), { ...cfg, chat: { followup: false } }, clock), null)
  assert.equal(chatOpportunity(store.read(), { ...cfg, listen: { dmOwner: false } }, clock), null)

  // 端到端验证 affect-worker 直接通过 createAffectSend 发出补话私信
  const sentCalls = []
  const followupText = '对了，记得把简历和作品集也提前在手机里存一份备用'
  const worker = createAffectWorker({
    store: () => store,
    config: () => cfg,
    now: () => clock,
    persona: () => '你是大鲸鱼',
    environment: () => ({ busy: false, networkPaused: false }),
    complete: Object.assign(async ({ stage }) => {
      if (stage === 'analysis') return JSON.stringify({ moodEffects: [], topicEffects: [], contextHints: [] })
      if (stage === 'generate') return JSON.stringify({ action: 'send', text: followupText })
      if (stage === 'coverage-check') return JSON.stringify({ covered: true, quote: '提前在手机里存一份备用' })
      return JSON.stringify({ checks: [] })
    }, { available: () => true }),
    send: createAffectSend(async (args) => {
      sentCalls.push(args)
      if (args.includes('--go')) {
        const planId = args[args.indexOf('--affect-plan') + 1]
        const text = args[args.indexOf('--msg') + 1]
        const tok = await store.reserve({ channel: 'dm', target: '300', text, auto: true, scene: 'private-reply', affectPlanId: planId })
        await store.dispatch(tok, () => {})
        await store.settle(tok, { status: 'sent', receipt: 'msg-followup-1' })
      }
      return { ok: true, out: 'ok', err: '' }
    }),
  })

  const tickRes = await worker.tick()
  assert.equal(tickRes.status, 'sent')
  assert.equal(sentCalls.length, 2) // --dry then --go
  assert.ok(sentCalls[0].includes('--dry'))
  assert.ok(sentCalls[1].includes('--go'))
  assert.ok(sentCalls[1].includes('--affect-plan'))
  assert.equal(sentCalls[1].includes('--draft'), false)
  assert.equal(store.read().drafts.length, 0)
})

test('Q8 dual safety review fails closed when Sidecar is offline or returns non-pass, and blocks obfuscated redlines', async t => {
  const { dir } = fixture(t)

  // 夹杂混淆分隔符的违规文本仍应命中本地安全红线
  const obf = checkLocalSafety('大家来看看线·上·赌·场充值渠道', {})
  assert.equal(obf.blocked, true)

  // 双重审核模式且 Sidecar 离线时应闭环拦截并给出指引
  const offlineDual = await enforceOutboundSafety({
    text: '这段猫猫视频太治愈了',
    channel: 'comment',
    cfg: { safety: { enabled: true, mode: 'dual', scope: 'all', customWords: [] } },
    whaleHome: dir,
    ipcClient: async () => ({ running: false }),
  })
  assert.equal(offlineDual.ok, false)
  assert.equal(offlineDual.blocked, true)
  assert.equal(offlineDual.layer, 'model-unavailable')
  assert.match(offlineDual.reason, /local_only|后台守护/)

  // 双重审核模式下 Sidecar 异常或未放行时应闭环拦截
  const errDual = await enforceOutboundSafety({
    text: '这段猫猫视频太治愈了',
    channel: 'comment',
    cfg: { safety: { enabled: true, mode: 'dual', scope: 'all', customWords: [] } },
    whaleHome: dir,
    ipcClient: async () => ({ running: true, ok: true, checked: false, decision: 'error', reason: '模型超时' }),
  })
  assert.equal(errDual.ok, false)
  assert.equal(errDual.blocked, true)

  // local_only 模式下即使 Sidecar 离线仍允许合规文本通过
  const localOk = await enforceOutboundSafety({
    text: '这段猫猫视频太治愈了',
    channel: 'comment',
    cfg: { safety: { enabled: true, mode: 'local_only', scope: 'all', customWords: [] } },
    whaleHome: dir,
    ipcClient: async () => ({ running: false }),
  })
  assert.equal(localOk.ok, true)
  assert.equal(localOk.layer, 'local')
})

test('dynamic switch, share.via routing, and comment 1000-char limit are strictly enforced', async t => {
  const { dir, cfgFile, env } = fixture(t)
  fs.writeFileSync(path.join(dir, 'credentials.json'), JSON.stringify({ sessdata: 'test-sess', bili_jct: 'a'.repeat(32), buvid3: 'b3' }))

  // 1. 关闭 chat.dynamic 时即使未传 --auto 也禁止发动态
  fs.writeFileSync(cfgFile, JSON.stringify({
    self: { mid: '100', name: '大鲸鱼' },
    owner: { mid: '300', name: '主人' },
    chat: { dynamic: false },
    share: { enabled: false, via: 'comment' },
    safety: { enabled: true, mode: 'local_only', scope: 'all', customWords: [] },
  }))
  await assert.rejects(
    exec(process.execPath, [cli, 'dynamic', 'post', '--text', '测试公开动态', '--dry'], { env, timeout: 10_000 }),
    /公开动态未开启或今日额度已用完/,
  )

  // 2. 关闭 share.enabled 时拦截 comment --share
  await assert.rejects(
    exec(process.execPath, [cli, 'comment', '--oid', '123', '--bvid', 'BV1xx411c7mD', '--message', '@主人 好看', '--share', '--dry'], { env, timeout: 10_000 }),
    /share\.enabled\s*=\s*false|主动分享已在设置中关闭/,
  )

  // 3. 分享通道设为私信时拦截 comment --share
  fs.writeFileSync(cfgFile, JSON.stringify({
    self: { mid: '100', name: '大鲸鱼' },
    owner: { mid: '300', name: '主人' },
    share: { enabled: true, via: 'dm' },
    safety: { enabled: true, mode: 'local_only', scope: 'all', customWords: [] },
  }))
  await assert.rejects(
    exec(process.execPath, [cli, 'comment', '--oid', '123', '--bvid', 'BV1xx411c7mD', '--message', '@主人 好看', '--share', '--dry'], { env, timeout: 10_000 }),
    /share\.via\s*=\s*dm/,
  )

  // 4. 分享通道设为评论区时拦截 dm --share
  fs.writeFileSync(cfgFile, JSON.stringify({
    self: { mid: '100', name: '大鲸鱼' },
    owner: { mid: '300', name: '主人' },
    share: { enabled: true, via: 'comment' },
    safety: { enabled: true, mode: 'local_only', scope: 'all', customWords: [] },
  }))
  await assert.rejects(
    exec(process.execPath, [cli, 'dm', '--account', '100', '--to', '300', '--msg', '看这个 https://www.bilibili.com/video/BV1xx411c7mD', '--share', '--target', 'BV1xx411c7mD', '--dry'], { env, timeout: 10_000 }),
    /share\.via\s*=\s*comment|当前分享通道/,
  )

  // 5. 评论正文超过 1000 字符时直接拒绝
  const over1000 = '长'.repeat(1001)
  await assert.rejects(
    exec(process.execPath, [cli, 'comment', '--oid', '123', '--bvid', 'BV1xx411c7mD', '--message', over1000, '--dry'], { env, timeout: 10_000 }),
    /1000/,
  )
})

test('dm-await delivers first-ever fan DM and advances cursor when fan exceeds daily quota', async t => {
  const { dir, cfgFile, env } = fixture(t)
  fs.writeFileSync(path.join(dir, 'credentials.json'), JSON.stringify({ sessdata: 'test-sess', bili_jct: 'a'.repeat(32), buvid3: 'b3' }))
  const cfgObj = {
    self: { mid: '100', name: '大鲸鱼' },
    owner: { mid: '300', name: '主人' },
    listen: { dmOwner: true, dmFan: true },
    fanLimits: { dmPerUserDaily: 1, dmTotalDaily: 5 },
  }
  fs.writeFileSync(cfgFile, JSON.stringify(cfgObj))

  // 初始化已建立历史基线的私信监听状态（非首次启动）
  const nowSec = Math.floor(Date.now() / 1000)
  const baselineSec = nowSec - 120
  const msgTs501 = nowSec - 10
  const msgTs502 = nowSec - 5
  const scope = dmListenerScope(cfgObj, dir)
  fs.mkdirSync(path.dirname(scope.stateFile), { recursive: true })
  fs.writeFileSync(scope.stateFile, JSON.stringify({
    owner: '300',
    lastSeen: baselineSec,
    fanBaselineAt: baselineSec,
    fanCursors: {},
    queue: [],
  }))

  const stub = `globalThis.fetch = async (url) => {
    const u = String(url);
    if (u.includes('/x/web-interface/nav')) {
      return Response.json({
        code: 0,
        data: {
          isLogin: true,
          mid: 100,
          uname: '大鲸鱼',
          wbi_img: {
            img_url: 'https://x/abcdef0123456789abcdef0123456789.png',
            sub_url: 'https://x/0123456789abcdef0123456789abcdef.png',
          },
        },
      });
    }
    if (u.includes('get_sessions')) {
      return Response.json({
        code: 0,
        data: {
          session_list: [
            { talker_id: 501, account_info: { name: '新粉丝501' }, last_msg: { msg_seqno: 1, sender_uid: 501, msg_type: 1, timestamp: ${msgTs501}, content: JSON.stringify({ content: '你好大鲸鱼，我是新粉丝！' }) } },
            { talker_id: 502, account_info: { name: '超限粉丝502' }, last_msg: { msg_seqno: 2, sender_uid: 502, msg_type: 1, timestamp: ${msgTs502}, content: JSON.stringify({ content: '我今天已经发过上限了' }) } },
          ],
        },
      });
    }
    if (u.includes('fetch_session_msgs') && u.includes('talker_id=300')) {
      return Response.json({ code: 0, data: { messages: [] } });
    }
    if (u.includes('fetch_session_msgs') && u.includes('talker_id=501')) {
      return Response.json({
        code: 0,
        data: { messages: [{ msg_seqno: 1, sender_uid: 501, msg_type: 1, msg_key: 'k501', content: JSON.stringify({ content: '你好大鲸鱼，我是新粉丝！' }), timestamp: ${msgTs501} }] },
      });
    }
    if (u.includes('fetch_session_msgs') && u.includes('talker_id=502')) {
      return Response.json({
        code: 0,
        data: { messages: [{ msg_seqno: 2, sender_uid: 502, msg_type: 1, msg_key: 'k502', content: JSON.stringify({ content: '我今天已经发过上限了' }), timestamp: ${msgTs502} }] },
      });
    }
    if (u.includes('/x/space/acc/relation')) {
      return Response.json({ code: 0, data: { relation: { attribute: 0 }, be_relation: { attribute: 2 } } });
    }
    throw Error('Unexpected fetch: ' + u);
  };`
  const preload = `data:text/javascript;base64,${Buffer.from(stub).toString('base64')}`

  // 预先耗尽粉丝 502 的当日私信配额
  recordFanReply({ channel: 'dm', uid: '502', whaleHome: dir })

  const r = await exec(process.execPath, ['--import', preload, cli, 'dm-await', '--once', '--json', '--peek'], {
    env: { ...env, NODE_OPTIONS: `--import=${preload}` },
    timeout: 10_000,
  })
  const out = JSON.parse(r.stdout.trim().split('\n').pop())
  assert.equal(out.hit, true)
  assert.equal(out.isFan, true)
  assert.equal(String(out.mid), '501')
  assert.equal(out.text, '你好大鲸鱼，我是新粉丝！')

  // 超额粉丝 502 的游标应在同轮推进，避免死循环重读
  const cursorAfterFirst = JSON.parse(fs.readFileSync(scope.stateFile, 'utf8'))
  assert.equal(cursorAfterFirst.fanCursors['502']?.lastSeen, msgTs502, 'quota-exceeded fan cursor should advance')

  // 确认粉丝 501 回执后，下一轮轮询应干净返回 hit:false
  await exec(process.execPath, [cli, 'dm-await', '--ack', out.receipt], { env, timeout: 10_000 })
  const r2 = await exec(process.execPath, ['--import', preload, cli, 'dm-await', '--once', '--json', '--peek'], {
    env: { ...env, NODE_OPTIONS: `--import=${preload}` },
    timeout: 10_000,
  }).catch(err => ({ stdout: err.stdout, code: err.code }))
  const out2 = JSON.parse(String(r2.stdout).trim().split('\n').pop())
  assert.equal(out2.hit, false)
})

test('debrief parses --profile before BVID and applies dislike filter only to auto profile', async t => {
  const { dir, cfgFile, env } = fixture(t)
  fs.writeFileSync(path.join(dir, 'credentials.json'), JSON.stringify({ sessdata: 'test-sess', bili_jct: 'a'.repeat(32), buvid3: 'b3' }))
  fs.writeFileSync(cfgFile, JSON.stringify({
    self: { mid: '100', name: '大鲸鱼' },
    owner: { mid: '300', name: '主人' },
    preferences: { like: ['AI'], dislike: ['标题党'] },
    watch: {
      auto: { maxDurationMin: 10, minDurationSec: 60 },
      ownerMention: { autoMaxMin: 10, confirmMaxMin: 20 },
      fanMention: { autoMaxMin: 5 },
    },
  }))

  const stub = `globalThis.fetch = async (url) => {
    const u = String(url);
    if (u.includes('/x/web-interface/nav')) return Response.json({ code: 0, data: { wbi_img: { img_url: 'https://x/abcdef0123456789abcdef0123456789.png', sub_url: 'https://x/0123456789abcdef0123456789abcdef.png' } } });
    if (u.includes('bvid=BV1flag00001')) return Response.json({ code: 0, data: { bvid: 'BV1flag00001', aid: 11, cid: 22, title: '标题党长视频测试', duration: 900, owner: { mid: 9, name: 'UP' }, stat: {} } });
    if (u.includes('bvid=BV1disl00001')) return Response.json({ code: 0, data: { bvid: 'BV1disl00001', aid: 12, cid: 23, title: '标题党短视频测试', duration: 300, owner: { mid: 9, name: 'UP' }, stat: {} } });
    throw Error('Unexpected fetch: ' + u);
  };`
  const preload = `data:text/javascript;base64,${Buffer.from(stub).toString('base64')}`
  const runDebrief = (...args) => exec(process.execPath, ['--import', preload, cli, 'debrief', ...args], {
    env: { ...env, NODE_OPTIONS: `--import=${preload}` },
    timeout: 10_000,
  })

  // --profile 位于 BV 号前时正常解析，且主人档不受 preferences.dislike 拦截
  await assert.rejects(runDebrief('--profile', 'owner', 'BV1flag00001'), /询问确认/)

  // 自主档在时长合法时受 preferences.dislike 屏蔽词拦截
  await assert.rejects(runDebrief('--profile', 'auto', 'BV1disl00001'), /在自主观看排除范围内/)
})

test('planIntervalFrames strictly increases, relation cache isolates accounts, pipelineConfig honors UI watch/night, and activity-stats tracks autoComments & fan items', async t => {
  const { dir } = fixture(t)

  // 1. 视频时长恰好为抽帧间隔整数倍时，尾部时间点不重复
  const plan = planIntervalFrames({ durationSec: 120, everySec: 30, maxFrames: 10, grid: '2x2' })
  assert.equal(plan.times.length, 4)
  for (let i = 1; i < plan.times.length; i++) {
    assert.ok(plan.times[i] > plan.times[i - 1], `times[${i}] (${plan.times[i]}) must be > times[${i - 1}] (${plan.times[i - 1]})`)
  }

  // 2. 关注关系缓存按不同账号凭据严格隔离
  clearRelationCache()
  const fetchByCookie = async (_url, opts) => {
    const cookie = String(opts?.headers?.cookie || '')
    if (cookie.includes('SESSDATA=acctA')) {
      return new Response(JSON.stringify({ code: 0, data: { relation: { attribute: 0 }, be_relation: { attribute: 2 } } }))
    }
    return new Response(JSON.stringify({ code: 0, data: { relation: { attribute: 0 }, be_relation: { attribute: 0 } } }))
  }
  assert.equal(await isFollowerOfWhale('888', { cookie: 'SESSDATA=acctA' }, { fetchImpl: fetchByCookie }), true)
  assert.equal(await isFollowerOfWhale('888', { cookie: 'SESSDATA=acctB' }, { fetchImpl: fetchByCookie }), false)
  clearRelationCache()

  // 3. UI 的 watch.auto 与 night.deepWatchMax 优先覆盖旧管线字段
  const pc = pipelineConfig({
    pipeline: { minDuration: 0, maxDuration: 7200, deepReadMax: 5 },
    watch: { auto: { minDurationSec: 60, maxDurationMin: 10 } },
    night: { deepWatchMax: 2 },
  })
  assert.equal(pc.minDuration, 60)
  assert.equal(pc.maxDuration, 600)
  assert.equal(pc.deepReadMax, 2)

  // 4. buildActivityCalendar 正确统计自主评论并保留粉丝互动非零时间戳
  const dayMs = Date.parse('2026-11-26T15:00:00+08:00')
  fs.mkdirSync(path.join(dir, 'state'), { recursive: true })
  fs.writeFileSync(path.join(dir, 'state', 'quota.json'), JSON.stringify({
    log: [
      { at: new Date(dayMs).toISOString(), type: 'comment', share: false, auto: true, target: 'BV:BV1aaa000001', note: '自主评论一条' },
      { at: new Date(dayMs + 1000).toISOString(), type: 'comment', share: true, auto: true, target: 'BV:BV1bbb000002', note: '分享给主人' },
    ],
  }))
  recordFanReply({ channel: 'dm', uid: '701', whaleHome: dir, now: () => dayMs + 2000 })
  const cal = buildActivityCalendar({ whaleHome: dir, cfg: { owner: { mid: '300' } }, store: null, now: () => dayMs + 3000 })
  assert.equal(cal.totals.autoComments, 1)
  assert.equal(cal.totals.shares, 1)
  assert.equal(cal.days['2026-11-26'].autoComments, 1)
  assert.equal(cal.days['2026-11-26'].shares, 1)
  assert.equal(cal.days['2026-11-26'].fanInteract, 1)
  assert.equal(cal.days['2026-11-26'].total, 3)
  assert.ok(cal.days['2026-11-26'].items.some(i => i.label === '自主评论'))
  assert.ok(cal.days['2026-11-26'].items.some(i => i.kind === 'fan' && i.at > 0))
})

test('scheduler self-heals NUL-corrupted whale-night.json on tick and wakeNow, and json-cache strips UTF-8 BOM', async t => {
  const { dir, cfgFile } = fixture(t)
  const credFile = path.join(dir, 'credentials.json')
  const nightFile = path.join(dir, 'state', 'schedule.json')
  fs.mkdirSync(path.dirname(nightFile), { recursive: true })
  fs.writeFileSync(credFile, JSON.stringify({ sessdata: 'test-sess', bili_jct: 'a'.repeat(32), buvid3: 'b3' }))
  // 写入带 UTF-8 BOM 的 config.json 验证 createJsonCache 兼容处理
  fs.writeFileSync(cfgFile, '\uFEFF' + JSON.stringify({
    self: { mid: '100', name: '大鲸鱼' },
    owner: { mid: '300', name: '主人' },
    browse: { enabled: true },
    models: { main: 'flash', worker: 'flash_lite', minQuotaPercent: 0 },
    night: { windows: [{ start: '00:00', end: '24:00', wakes: 5 }], skipChance: 0, minGapMin: 10 },
  }))
  assert.equal(createJsonCache().read(cfgFile).self.mid, '100')

  // 模拟异常断电导致的 NUL 填充损坏计划文件（state/schedule.json）
  fs.writeFileSync(nightFile, Buffer.alloc(559, 0))

  const prompts = []
  const sched = startScheduler({
    rpc: { available: () => false },
    sessionController: {
      available: () => true,
      isBusy: async () => false,
      createAndPrompt: async (req) => { prompts.push(req); return { sessionId: 'sess-heal-1' } },
      prompt: async (req) => { prompts.push(req); return { ok: true } },
    },
  }, {
    whaleHome: dir,
    configFile: cfgFile,
    credentialsFile: credFile,
    biliMjs: cli,
    cwd: dir,
  })
  t.after(() => sched.stop())

  // 1. tick() 应自愈 NUL 损坏的计划文件并重建有效排期
  await sched.tick()
  assert.equal(sched.health().lastError, null)
  const repairedByTick = JSON.parse(fs.readFileSync(nightFile, 'utf8'))
  assert.equal(typeof repairedByTick.action, 'string')

  // 2. 再次破坏计划文件后，wakeNow() 同样应自愈并正常投递
  fs.writeFileSync(nightFile, Buffer.alloc(559, 0))
  const res = await sched.wakeNow()
  assert.equal(res.ok, true)
  assert.ok(prompts.length >= 1)
  assert.equal(sched.health().lastError, null)
  const repairedByWake = JSON.parse(fs.readFileSync(nightFile, 'utf8'))
  assert.equal(repairedByWake.action, 'wake')
  assert.ok(repairedByWake.wakes >= 1)
})
