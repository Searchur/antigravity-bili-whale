import test from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { createMcpRouter } from '../mcp/server.mjs'
import { createModelToolRunner } from '../mcp/model-tools.mjs'
import { createApiHandlers } from '../lib/api-handlers.js'
import { createAffectWorker, createAffectSend } from '../lib/affect-worker.js'
import { buildActivityCalendar } from '../lib/activity-stats.js'
import { lifeStore } from '../tools/lib/life-runtime.mjs'
import { chatOpportunity } from '../tools/lib/chat-opportunity.mjs'
import { checkLocalSafety, enforceOutboundSafety } from '../tools/lib/content-safety.mjs'
import { isFollowerOfWhale, clearRelationCache } from '../tools/lib/relation.mjs'
import { planIntervalFrames } from '../tools/lib/watch-options.mjs'
import { pipelineConfig } from '../tools/local/pipeline-config.mjs'
import { recordFanReply } from '../tools/lib/fan-quota.mjs'
import { dmListenerScope } from '../tools/lib/dm-listener-scope.mjs'

const exec = promisify(execFile)
const cli = fileURLToPath(new URL('../tools/bili.mjs', import.meta.url))

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

  // whale_app_life enum strictly matches Tab 6 UI
  const listRes = await router.handleRequest({ jsonrpc: '2.0', id: 1, method: 'tools/list' })
  const lifeTool = listRes.result.tools.find(x => x.name === 'whale_app_life')
  assert.deepEqual(lifeTool.inputSchema.properties.action.enum, ['status', 'pause', 'search', 'export', 'resolve'])

  // traffic is read-only (status only)
  const badTraffic = await runner('bili_life', { command: 'traffic', args: ['resume'] })
  assert.equal(badTraffic.isError, true)
  assert.match(badTraffic.content[0].text, /管理数据请在控制台查看|traffic status/)

  // config is read-only (show only)
  const badConfig = await runner('bili_ops', { command: 'config', args: ['set', 'deepReadMax', '5'] })
  assert.equal(badConfig.isError, true)
  assert.match(badConfig.content[0].text, /管理数据请在控制台查看|config show/)

  // Retired commands rejected across tools
  for (const [tool, command] of [
    ['bili_inspect', 'video'],
    ['bili_inspect', 'ai-share'],
    ['bili_interact', 'dynamic-edit'],
    ['bili_life', 'expression'],
    ['bili_life', 'corpus'],
  ]) {
    const res = await runner(tool, { command, args: [] })
    assert.equal(res.isError, true, `${tool}:${command} should be rejected`)
  }

  // behavior reload retired
  const badReload = await runner('bili_ops', { command: 'behavior', args: ['reload'] })
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
  const store = lifeStore(cfg, { dshHome: dir, fullConfig: () => cfg, now: () => clock })

  // No open thread yet -> no idle DM!
  assert.equal(chatOpportunity(store.read(), cfg, clock), null)

  // Owner sends a DM, whale sends first reply 1 min later, then 1 min later followup opportunity fires even at 02:00 with autonomy=false & share.enabled=false
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

  // Turning off chat.followup or listen.dmOwner disables followup completely
  assert.equal(chatOpportunity(store.read(), { ...cfg, chat: { followup: false } }, clock), null)
  assert.equal(chatOpportunity(store.read(), { ...cfg, listen: { dmOwner: false } }, clock), null)

  // End-to-end affect-worker executes direct DM send via createAffectSend without expression drafts
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

  // Obfuscated separator characters still match built-in redline
  const obf = checkLocalSafety('大家来看看线·上·赌·场充值渠道', {})
  assert.equal(obf.blocked, true)

  // Dual mode + offline Sidecar -> fail-closed (blocked) with guidance
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

  // Dual mode + Sidecar error/non-pass verdict -> fail-closed (blocked)
  const errDual = await enforceOutboundSafety({
    text: '这段猫猫视频太治愈了',
    channel: 'comment',
    cfg: { safety: { enabled: true, mode: 'dual', scope: 'all', customWords: [] } },
    whaleHome: dir,
    ipcClient: async () => ({ running: true, ok: true, checked: false, decision: 'error', reason: '模型超时' }),
  })
  assert.equal(errDual.ok, false)
  assert.equal(errDual.blocked, true)

  // local_only mode still allows safe text when Sidecar is offline
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

  // 1. chat.dynamic=false blocks dynamic post EVEN WITHOUT --auto
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

  // 2. comment --share blocked when share.enabled=false
  await assert.rejects(
    exec(process.execPath, [cli, 'comment', '--oid', '123', '--bvid', 'BV1xx411c7mD', '--message', '@主人 好看', '--share', '--dry'], { env, timeout: 10_000 }),
    /share\.enabled\s*=\s*false|主动分享已在设置中关闭/,
  )

  // 3. comment --share blocked when share.via='dm'
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

  // 4. dm --share blocked when share.via='comment'
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

  // 5. comment rejects >1000 characters
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

  // Seed initialized dm listener state with fanBaselineAt in the past (not first-boot baseline)
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

  // Exhaust quota for fan 502 beforehand
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

  // Quota-exceeded fan 502 cursor was advanced on the same poll so it won't loop forever
  const cursorAfterFirst = JSON.parse(fs.readFileSync(scope.stateFile, 'utf8'))
  assert.equal(cursorAfterFirst.fanCursors['502']?.lastSeen, msgTs502, 'quota-exceeded fan cursor should advance')

  // Ack fan 501, then next poll returns hit:false cleanly
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

  // --profile BEFORE BVID works properly and owner profile is NOT blocked by preferences.dislike (reaches owner duration confirm guard instead!)
  await assert.rejects(runDebrief('--profile', 'owner', 'BV1flag00001'), /询问确认/)

  // auto profile IS blocked by preferences.dislike (when duration is within auto bounds)
  await assert.rejects(runDebrief('--profile', 'auto', 'BV1disl00001'), /在自主观看排除范围内/)
})

test('planIntervalFrames strictly increases, relation cache isolates accounts, pipelineConfig honors UI watch/night, and activity-stats tracks autoComments & fan items', async t => {
  const { dir } = fixture(t)

  // 1. planIntervalFrames has no duplicate trailing timestamp when duration is an exact multiple of interval
  const plan = planIntervalFrames({ durationSec: 120, everySec: 30, maxFrames: 10, grid: '2x2' })
  assert.equal(plan.times.length, 4)
  for (let i = 1; i < plan.times.length; i++) {
    assert.ok(plan.times[i] > plan.times[i - 1], `times[${i}] (${plan.times[i]}) must be > times[${i - 1}] (${plan.times[i - 1]})`)
  }

  // 2. relation cache isolates different account credentials
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

  // 3. UI watch.auto and night.deepWatchMax override legacy pipeline fields
  const pc = pipelineConfig({
    pipeline: { minDuration: 0, maxDuration: 7200, deepReadMax: 5 },
    watch: { auto: { minDurationSec: 60, maxDurationMin: 10 } },
    night: { deepWatchMax: 2 },
  })
  assert.equal(pc.minDuration, 60)
  assert.equal(pc.maxDuration, 600)
  assert.equal(pc.deepReadMax, 2)

  // 4. buildActivityCalendar counts autoComments & preserves fan items with non-zero timestamp
  const dayMs = Date.parse('2026-11-26T15:00:00+08:00')
  fs.writeFileSync(path.join(dir, 'quota.json'), JSON.stringify({
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
