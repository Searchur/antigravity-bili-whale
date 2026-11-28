/**
 * 私信与评论监听回归测试：覆盖通道启停、游标断点续扫、粉丝关系重试与关闭线程冷却。
 */
import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-listener-test-'))
process.env.BILI_WHALE_HOME = root
process.env.BILI_WHALE_CONFIG = path.join(root, 'config.json')
process.env.BILI_TRAFFIC_TEST = '1'
after(() => fs.rmSync(root, { recursive: true, force: true }))
const { dmListenerScope } = await import('../../src/social/dm-listener-scope.mjs')
const { startScheduler } = await import('../../src/daemon/scheduler.mjs')
const { createSessionDelivery } = await import('../../src/daemon/session-delivery.mjs')
const write = (file, obj) => fs.writeFileSync(file, JSON.stringify(obj))
const read = file => JSON.parse(fs.readFileSync(file, 'utf8'))

function fixture(listen) {
  const dir = fs.mkdtempSync(path.join(root, 'case-'))
  const config = { self: { mid: '100' }, owner: { mid: '200' }, listen, life: { enabled: false }, models: { minQuotaPercent: 0 } }
  const configFile = path.join(dir, 'config.json')
  const save = () => write(configFile, config)
  save()
  const credentialsFile = path.join(dir, 'credentials.json')
  write(credentialsFile, { sessdata: 'test', bili_jct: 'test' })
  const { stateFile } = dmListenerScope(config, dir)
  fs.mkdirSync(path.dirname(stateFile), { recursive: true })
  const shim = path.join(dir, 'transport.mjs')
  fs.writeFileSync(shim, 'globalThis.fetch = async () => { throw Error("Unexpected fixture request") }')
  const run = (entry, ...args) => spawnSync(process.execPath, ['--import', pathToFileURL(shim).href, entry, ...args], {
    env: { ...process.env, BILI_WHALE_HOME: dir, BILI_WHALE_CONFIG: configFile }, encoding: 'utf8', windowsHide: true,
  })
  return { dir, config, save, credentialsFile, stateFile, cli: (...args) => run('src/cli/commands/dm-await.mjs', ...args), run, shim }
}

function dmTransport(f, handler) {
  fs.writeFileSync(f.shim, `
    import fs from 'node:fs'
    import path from 'node:path'
    const ok = data => Response.json({ code: 0, data })
    const msg = (seq, sender = 200, timestamp = 100, key = String(seq)) => ({
      msg_seqno: seq, sender_uid: sender, timestamp, msg_key: key, content: '{"content":"相同正文"}',
    })
    globalThis.fetch = async input => {
      const url = new URL(input), route = url.pathname.split('/').at(-1)
      if (route === 'nav') return ok({ isLogin: true, mid: 100, wbi_img: {
        img_url: 'https://fixture.invalid/' + 'a'.repeat(32) + '.png',
        sub_url: 'https://fixture.invalid/' + 'b'.repeat(32) + '.png',
      } })
      if (url.pathname.includes('/relation')) return ok({ relation: { attribute: 0 }, be_relation: { attribute: 2 } })
      return (${handler.toString()})(route, url)
    }
  `)
}

function dmResult(f, status, ...args) {
  const result = f.cli('--peek', '--json', ...args)
  assert.equal(result.status, status, result.stderr || result.stdout)
  return JSON.parse(result.stdout)
}

test('first successful DM reads set independent baselines and resuming delivers only later arrivals', () => {
  const f = fixture({ dmOwner: true, dmFan: true })
  dmTransport(f, (route, url) => {
    const resumed = fs.existsSync(path.join(process.env.BILI_WHALE_HOME, 'resumed'))
    const ts = Math.floor(Date.now() / 1000)
    if (route === 'get_sessions') return ok({ has_more: 0, session_list: [
      { talker_id: 300, last_msg: msg(resumed ? 2 : 1, 300, ts) },
    ] })
    const sender = Number(url.searchParams.get('talker_id'))
    const rows = [msg(1, sender, ts)]
    if (resumed) rows.unshift(msg(2, sender, ts))
    return ok({ has_more: 0, max_seqno: resumed ? 2 : 1, messages: rows })
  })
  assert.equal(dmResult(f, 1).hit, false)
  const anchored = read(f.stateFile)
  assert.equal(anchored.lastSeq, '1')
  assert.equal(anchored.fanCursors['300'].lastSeq, '1')
  f.config.listen.dmOwner = f.config.listen.dmFan = false
  f.save()
  write(path.join(f.dir, 'resumed'), true)
  assert.equal(dmResult(f, 1).hit, false)
  assert.deepEqual(read(f.stateFile), anchored)
  f.config.listen.dmOwner = f.config.listen.dmFan = true
  f.save()
  const arrivals = []
  for (let index = 0; index < 2; index++) {
    const pending = dmResult(f, 0)
    arrivals.push([pending.mid, pending.seq])
    assert.equal(f.cli('--ack', pending.receipt).status, 0)
  }
  assert.deepEqual(arrivals.sort(), [['200', '2'], ['300', '2']])
  assert.equal(dmResult(f, 1).hit, false)
})

test('owner and fan retain exact DM sequence across a key change and deliver distinct same-second texts', () => {
  for (const isFan of [false, true]) {
    const f = fixture({ dmOwner: !isFan, dmFan: isFan })
    write(f.stateFile, { lastSeen: 90, fanBaselineAt: 90 })
    const exactSeq = '9007199254740993'
    dmTransport(f, (route, url) => {
      const phase = fs.existsSync(path.join(process.env.BILI_WHALE_HOME, 'changed'))
      const sender = Number(url.searchParams.get('talker_id') || 300)
      const newest = phase ? '9007199254740994' : '9007199254740993'
      if (route === 'get_sessions') return ok({ session_list: [{ talker_id: 300, last_msg: msg(newest, 300) }] })
      const content = '{"content":"same text"}'
      const raw = phase
        ? [{ ...msg(newest, sender, 100, 'different'), content }, { ...msg('9007199254740993', sender, 100, 'added-key'), content }]
        : [{ ...msg('9007199254740993', sender), msg_key: undefined, content }]
      const json = JSON.stringify({ code: 0, data: { messages: raw, has_more: 0 } })
      return new Response(json.replace(/"msg_seqno":"(\d+)"/g, '"msg_seqno":$1'))
    })
    const first = dmResult(f, 0)
    assert.equal(first.seq, exactSeq)
    assert.equal(dmResult(f, 0).receipt, first.receipt)
    assert.equal(f.cli('--ack', first.receipt).status, 0)
    write(path.join(f.dir, 'changed'), true)
    const next = dmResult(f, 0)
    assert.equal(next.seq, '9007199254740994')
    assert.equal(next.text, first.text)
    assert.equal(f.cli('--ack', next.receipt).status, 0)
    assert.equal(dmResult(f, 1).hit, false)
  }
})

test('DM key fallback prevents replay when a delivered message first gains its sequence', () => {
  for (const isFan of [false, true]) {
    const f = fixture({ dmOwner: !isFan, dmFan: isFan })
    write(f.stateFile, { lastSeen: 90, lastSeq: '1', fanBaselineAt: 90, fanCursors: { 300: { lastSeen: 90, lastSeq: '1' } } })
    dmTransport(f, (route, url) => {
      const seq = fs.existsSync(path.join(process.env.BILI_WHALE_HOME, 'changed')) ? 2 : undefined
      const sender = Number(url.searchParams.get('talker_id') || 300)
      const row = msg(seq, sender, 100, 'stable-key')
      if (route === 'get_sessions') return ok({ session_list: [{ talker_id: 300, last_msg: row }] })
      return ok({ messages: [row], has_more: 0 })
    })
    const first = dmResult(f, 0)
    assert.equal(first.seq, undefined)
    assert.equal(f.cli('--ack', first.receipt).status, 0)
    write(path.join(f.dir, 'changed'), true)
    assert.equal(dmResult(f, 1).hit, false)
  }
})

test('a previously unseen fan conversation does not replay messages from its baseline second', () => {
  const f = fixture({ dmFan: true })
  write(f.stateFile, { fanBaselineAt: 100 })
  dmTransport(f, (route) => {
    if (route === 'get_sessions') return ok({ session_list: [{ talker_id: 300, last_msg: msg(2, 300, 101) }] })
    return ok({ messages: [msg(2, 300, 101), msg(1, 300, 100)], has_more: 0 })
  })
  const result = dmResult(f, 0)
  assert.equal(result.seq, '2')
  assert.equal(f.cli('--ack', result.receipt).status, 0)
  assert.equal(dmResult(f, 1).hit, false)
})

test('a known fan baseline skips unsequenced same-second history while allowing a newer sequence', () => {
  for (const withoutSequence of [false, true]) {
    const f = fixture({ dmFan: true })
    write(path.join(f.dir, 'baseline-without-seq'), withoutSequence)
    dmTransport(f, (route) => {
      const root = process.env.BILI_WHALE_HOME
      const legacy = JSON.parse(fs.readFileSync(path.join(root, 'baseline-without-seq'), 'utf8'))
      const enabled = fs.existsSync(path.join(root, 'new-arrival'))
      const known = msg(legacy ? undefined : 2, 300, 100, 'baseline-head')
      const latest = msg(3, 300, legacy ? 101 : 100)
      if (route === 'get_sessions') return ok({ session_list: [{ talker_id: 300, last_msg: enabled ? latest : known }] })
      return ok({ messages: [latest, known, msg(undefined, 300, 100, 'older-same-second')], has_more: 0 })
    })
    assert.equal(dmResult(f, 1).hit, false)
    write(path.join(f.dir, 'new-arrival'), true)
    const pending = dmResult(f, 0)
    assert.equal(pending.seq, '3')
    assert.equal(read(f.stateFile).queue.length, 0)
  }
})

test('owner DM history resumes end_seqno pagination and checks withdrawals before delivery', () => {
  const f = fixture({ dmOwner: true })
  write(f.stateFile, { lastSeen: 100, lastSeq: '1' })
  dmTransport(f, (route, url) => {
    if (route !== 'fetch_session_msgs' || url.searchParams.get('begin_seqno')) throw Error('历史翻页参数错误')
    const end = url.searchParams.get('end_seqno')
    const log = path.join(process.env.BILI_WHALE_HOME, 'pages')
    const recheck = !end && fs.existsSync(log)
    fs.appendFileSync(log, (end ?? 'latest') + '\n')
    if (recheck) return ok({
      messages: [{ ...msg(13), msg_type: 5, content: '{"msg_key":"12"}' }, msg(12)],
      min_seqno: 12, max_seqno: 13, has_more: 1,
    })
    const seq = end ? Number(end) - 1 : 12
    const rows = [msg(seq)]
    if (end) rows.unshift(msg(Number(end)))
    return ok({ messages: rows, min_seqno: seq, max_seqno: 12, has_more: seq > 1 ? 1 : 0 })
  })
  assert.equal(dmResult(f, 1).hit, false)
  assert.equal(read(f.stateFile).lastSeq, '1')
  const next = dmResult(f, 0)
  assert.equal(next.seq, '2')
  const queued = read(f.stateFile).queue.map(row => row.seq)
  assert.deepEqual(queued, ['3', '4', '5', '6', '7', '8', '9', '10', '11'])
  assert.deepEqual(fs.readFileSync(path.join(f.dir, 'pages'), 'utf8').trim().split('\n'),
    ['latest', '12', '11', '10', '9', '8', '7', '6', '5', '4', '3', '2', 'latest'])
})

test('fan scan continues past the first twelve sessions and follows signed end_ts pages', () => {
  const f = fixture({ dmFan: true })
  write(f.stateFile, { fanBaselineAt: 90 })
  dmTransport(f, (route, url) => {
    const end = url.searchParams.get('end_ts')
    if (route === 'get_sessions') {
      if (!url.searchParams.get('w_rid')) throw Error('缺少会话列表签名')
      if (!end) return ok({ has_more: 1, session_list: [
        ...Array.from({length:12}, (_, i) => ({ talker_id: 400+i, session_ts: String(120-i), last_msg: msg(1, 400+i, 80) })),
        { talker_id: 301, session_ts: '108', last_msg: msg(3, 100, 105) },
      ] })
      if (end !== '108') throw Error('错误的会话历史分页位置')
      return ok({ has_more: 0, session_list: [{ talker_id: 302, session_ts: '107', last_msg: msg(2, 302) }] })
    }
    const talker = Number(url.searchParams.get('talker_id'))
    const rows = [msg(2, talker)]
    if (talker === 301) rows.unshift(msg(3, 100, 105))
    return ok({ has_more: 0, messages: rows })
  })
  assert.equal(dmResult(f, 1).hit, false)
  const first = dmResult(f, 0)
  assert.equal(first.mid, '301')
  assert.equal(first.seq, '2')
  assert.equal(f.cli('--ack', first.receipt).status, 0)
  const second = dmResult(f, 0)
  assert.equal(second.mid, '302')
})

test('a failing older fan page leaves its cursor but allows new messages from the first page', () => {
  const f = fixture({ dmFan: true })
  write(f.stateFile, { fanBaselineAt: 90, fanScan: { remaining: [], nextEndTs: '1000' } })
  dmTransport(f, (route, url) => {
    if (route === 'get_sessions') {
      if (url.searchParams.get('end_ts')) return Response.json({ code: -400 })
      return ok({ session_list: [{ talker_id: 301, last_msg: msg(2, 301) }], has_more: 0 })
    }
    return ok({ messages: [msg(2, 301)], has_more: 0 })
  })
  assert.deepEqual(dmResult(f, 3).readErrors, [{ stage: 'sessions', code: -400 }])
  const newest = dmResult(f, 0)
  assert.equal(newest.mid, '301')
  assert.equal(read(f.stateFile).fanScan.nextEndTs, '1000')
})

test('fan read errors retain its baseline and preserve owner arrivals from the same round', () => {
  const f = fixture({ dmOwner: true, dmFan: true })
  write(f.stateFile, { lastSeen: 90 })
  dmTransport(f, (route) => route === 'get_sessions'
    ? Response.json({ code: -400, message: 'fixture error' })
    : ok({ has_more: 0, messages: [msg(1)] }))
  const owner = dmResult(f, 0)
  assert.equal(owner.mid, '200')
  assert.deepEqual(owner.readErrors, [{ stage: 'sessions', code: -400 }])
  assert.equal(read(f.stateFile).fanBaselineAt, undefined)
  assert.equal(f.cli('--ack', owner.receipt).status, 0)
  assert.deepEqual(dmResult(f, 3).readErrors, [{ stage: 'sessions', code: -400 }])
  assert.equal(read(f.stateFile).lastSeq, '1')
})

test('history failures retain successful older-page progress and allow a fan message to go through', () => {
  const f = fixture({ dmOwner: true, dmFan: true })
  write(f.stateFile, { lastSeen: 90, lastSeq: '1', fanBaselineAt: 90 })
  dmTransport(f, (route, url) => {
    if (route === 'get_sessions') return ok({ session_list: [{ talker_id: 300, last_msg: msg(2, 300) }] })
    if (url.searchParams.get('talker_id') === '300') return ok({ messages: [msg(2, 300)], has_more: 0 })
    const end = url.searchParams.get('end_seqno')
    fs.appendFileSync(path.join(process.env.BILI_WHALE_HOME, 'pages'), (end ?? 'latest') + '\n')
    if (!end) return ok({ messages: [msg(3)], min_seqno: 3, has_more: 1 })
    if (!fs.existsSync(path.join(process.env.BILI_WHALE_HOME, 'recovered'))) return Response.json({ code: -404 })
    return ok({ messages: [msg(2)], has_more: 0 })
  })
  const fan = dmResult(f, 0)
  assert.equal(fan.mid, '300')
  assert.deepEqual(fan.readErrors, [{ stage: 'owner-history', code: -404 }])
  assert.equal(read(f.stateFile).lastSeq, '1')
  assert.equal(f.cli('--ack', fan.receipt).status, 0)
  write(path.join(f.dir, 'recovered'), true)
  const owner = dmResult(f, 0)
  assert.equal(owner.seq, '2')
  assert.equal(read(f.stateFile).queue[0].seq, '3')
  assert.deepEqual(fs.readFileSync(path.join(f.dir, 'pages'), 'utf8').trim().split('\n'), ['latest', '3', '3', 'latest'])
})

test('scheduler logs the DM read stage and platform code from a failed poll', async () => {
  const f = fixture({ dmOwner: true, dmFan: true })
  const child = path.join(f.dir, 'failed-poll.mjs')
  fs.writeFileSync(child, `
    console.log(JSON.stringify({ hit: false, readErrors: [{ stage: 'sessions', code: -400 }] }))
    process.exitCode = 3
  `)
  const scheduler = startScheduler({}, { whaleHome: f.dir, cwd: f.dir, biliMjs: child, credentialsFile: f.credentialsFile })
  try { await scheduler.dmTick() } finally { scheduler.stop() }
  const log = fs.readFileSync(path.join(f.dir, 'logs', 'dm-listener-errors.log'), 'utf8')
  assert.match(log, /private-message sessions -400/)
})

test('a scheduler restart settles a delivered DM without another submission when acknowledgement failed', async () => {
  const f = fixture({ dmOwner: true })
  const pending = { hit: true, mid: '200', receipt: 'stable-receipt', key: 'incoming', seq: '9007199254740993', ts: 100, text: '测试来信' }
  write(f.stateFile, { pending, lastSeen: 90, lastSeq: '1' })
  const child = path.join(f.dir, 'ack-on-restart.mjs')
  fs.writeFileSync(child, `
    import fs from 'node:fs'
    const marker = ${JSON.stringify(path.join(f.dir, 'ack-blocked'))}
    if (process.argv.includes('--ack') && !fs.existsSync(marker)) {
      fs.writeFileSync(marker, 'fixture')
      process.exitCode = 3
    } else {
      process.argv.splice(2, 1)
      await import(${JSON.stringify(pathToFileURL(path.resolve('src/cli/commands/dm-await.mjs')).href)})
    }
  `)
  let submissions = 0
  const sessionController = {
    async createAndPrompt() { submissions++; return { sessionId: 'dm-fixture' } },
    async prompt() { submissions++ },
  }
  const round = async () => {
    const scheduler = startScheduler({ sessionController }, { whaleHome: f.dir, cwd: f.dir, biliMjs: child, credentialsFile: f.credentialsFile })
    try { await scheduler.dmTick() } finally { scheduler.stop() }
  }
  await round()
  assert.equal(submissions, 1)
  assert.equal(read(f.stateFile).pending.receipt, 'stable-receipt')
  assert.equal(read(f.stateFile).lastSeq, '1')
  await round()
  assert.equal(submissions, 1)
  assert.equal(read(f.stateFile).pending, undefined)
  assert.equal(read(f.stateFile).lastSeq, pending.seq)
})

test('a disabled pending DM keeps its receipt while the other channel delivers and acknowledges', () => {
  const f = fixture({ dmOwner: false, dmFan: true })
  const pending = { hit: true, receipt: 'owner-receipt', mid: '200', key: 'owner-message', ts: 10, text: 'owner', isFan: false }
  write(f.stateFile, { pending, queue: [{ mid: '300', key: 'fan-message', ts: 11, text: 'fan', isFan: true }] })
  const fan = f.cli('--peek', '--json')
  assert.equal(fan.status, 0, fan.stderr)
  const msg = JSON.parse(fan.stdout)
  assert.equal(msg.mid, '300')
  assert.equal(f.cli('--ack', msg.receipt).status, 0)
  f.config.listen.dmOwner = true
  f.save()
  const resumed = f.cli('--peek', '--json')
  assert.equal(resumed.status, 0, resumed.stderr)
  assert.equal(JSON.parse(resumed.stdout).receipt, 'owner-receipt')
  assert.equal(f.cli('--ack', 'owner-receipt').status, 0)
  assert.equal(read(f.stateFile).lastKey, 'owner-message')
  assert.equal(read(f.stateFile).fanCursors['300'].lastKey, 'fan-message')
})

test('a valid acknowledgement settles an already delivered private message after both channels stop', () => {
  const f = fixture({ dmOwner: false, dmFan: false })
  write(f.stateFile, { pending: { mid: '200', key: 'completed', receipt: 'accepted', ts: 10 } })
  const result = f.cli('--ack', 'accepted')
  assert.equal(result.status, 0, result.stderr)
  assert.equal(read(f.stateFile).lastKey, 'completed')
})

test('turning the fan channel off during its first poll preserves the baseline for when listening resumes', () => {
  const f = fixture({ dmOwner: false, dmFan: true })
  fs.writeFileSync(f.shim, `
    import fs from 'node:fs'
    globalThis.fetch = async input => {
      const url = new URL(input)
      if (url.pathname.endsWith('/nav')) return Response.json({code:0,data:{isLogin:true,mid:100,wbi_img:{img_url:'https://x/'+ 'a'.repeat(32)+'.png',sub_url:'https://x/'+ 'b'.repeat(32)+'.png'}}})
      if (!url.pathname.endsWith('/get_sessions')) throw Error('Unexpected fixture request')
      const file=process.env.BILI_WHALE_CONFIG, cfg=JSON.parse(fs.readFileSync(file))
      cfg.listen.dmFan=false
      fs.writeFileSync(file,JSON.stringify(cfg))
      return Response.json({code:0,data:{session_list:[{talker_id:'300',last_msg:{timestamp:100,sender_uid:'300'}}]}})
    }
  `)
  write(f.stateFile, { queue: [] })
  const result = f.cli('--json', '--peek')
  assert.equal(result.status, 1, result.stderr)
  assert.equal(JSON.parse(result.stdout).hit, false)
  assert.deepEqual(read(f.stateFile), { queue: [] })
})

test('host skips a private message when its channel stops while the listener child is running', async () => {
  const f = fixture({ dmOwner: true, dmFan: false })
  const child = path.join(f.dir, 'listener.mjs')
  fs.writeFileSync(child, `
    import fs from 'node:fs'
    if (!process.argv.includes('--peek')) throw Error('There was no delivery to settle')
    const file=process.env.BILI_WHALE_CONFIG, cfg=JSON.parse(fs.readFileSync(file))
    cfg.listen.dmOwner=false
    fs.writeFileSync(file,JSON.stringify(cfg))
    console.log(JSON.stringify({hit:true,mid:'200',isFan:false,receipt:'queued',text:'synthetic'}))
  `)
  let sent = 0
  const scheduler = startScheduler({ sessionController: { prompt() {}, async createAndPrompt() { sent++; return {sessionId:'unused'} } } },
    { whaleHome: f.dir, cwd: f.dir, biliMjs: child, credentialsFile: f.credentialsFile })
  try { await scheduler.dmTick() } finally { scheduler.stop() }
  assert.equal(read(path.join(f.dir,'config.json')).listen.dmOwner, false)
  assert.equal(sent, 0)
})

test('a comment disabled during polling neither prompts nor consumes the event; reenabling delivers it once', async t => {
  const f = fixture({ commentOwner: true, allDay: true })
  const cursor = path.join(f.dir, 'state', 'listen-cursor.json')
  fs.mkdirSync(path.dirname(cursor), { recursive: true })
  const ts = Math.floor(Date.now()/1000) - 20
  write(cursor, { identity: { account: '100', owner: '200' }, lastSeen: ts })
  let disable = true
  t.mock.method(globalThis, 'fetch', async input => {
    const url = new URL(input)
    if (url.pathname.endsWith('/reply')) return Response.json({ code: 0, data: { items: [
      { id: '10', reply_time: ts+1, user: { mid: 200 }, item: { source_content: 'synthetic', subject_id: 12, source_id: 123 } },
    ] } })
    assert.ok(url.pathname.endsWith('/at'))
    if (disable) { f.config.listen.commentOwner = false; f.save() }
    return Response.json({ code: 0, data: { items: [] } })
  })
  let sent = 0
  const start = () => startScheduler({ sessionController: { prompt() {}, async createAndPrompt() { sent++; return { sessionId: 'fixture' } } } },
    { whaleHome: f.dir, cwd: f.dir, biliMjs: 'unused', credentialsFile: f.credentialsFile })
  const first = start()
  try { await first.listenTick() } finally { first.stop() }
  assert.equal(sent, 0)
  assert.equal(read(cursor).lastSeen, ts)
  disable = false
  f.config.listen.commentOwner = true
  f.save()
  const next = start()
  try { await next.listenTick() } finally { next.stop() }
  assert.equal(sent, 1)
  assert.equal(read(cursor).lastSeen, ts+1)
})

test('the listener guard runs again after preparing async context and before host submission', async () => {
  const f = fixture({ commentOwner: true })
  let allowed = true, sent = 0
  const delivery = createSessionDelivery({ whaleHome: f.dir, sessionId: 'unused', config: () => f.config, persona: () => '',
    memoryContext: async () => { allowed = false; return '' },
    controller: { async createAndPrompt() { sent++; return { sessionId: 'test' } } } })
  await assert.rejects(delivery.send({ requestId: 'guard-1', content: [] }, undefined, {
    validate: () => { if (!allowed) throw Error('listener disabled') },
  }), /listener disabled/)
  assert.equal(sent, 0)
})

test('an unknown follower relation retries independently, and late same-second DM keys are delivered once', () => {
  const f = fixture({ dmFan: true })
  write(f.stateFile, { fanBaselineAt: 100, fanCursors: { 301: { lastSeen: 200, lastKey: 'old' } } })
  fs.writeFileSync(f.shim, `
    import fs from 'node:fs'
    import path from 'node:path'
    globalThis.fetch = async input => {
      const u = new URL(input), p = u.pathname, ok = data => Response.json({code:0,data})
      if (p.endsWith('/nav')) return ok({isLogin:true,mid:100,wbi_img:{img_url:'https://x/'+ 'a'.repeat(32)+'.png',sub_url:'https://x/'+ 'b'.repeat(32)+'.png'}})
      if (p.endsWith('/get_sessions')) return ok({session_list:['302','301'].map(id=>({talker_id:id,last_msg:{sender_uid:id,timestamp:200,msg_key:id+'new'}}))})
      if (p.includes('/relation')) {
        const id = u.searchParams.get('mid') || u.searchParams.get('fid')
        if (id === '302' && !fs.existsSync(path.join(process.env.BILI_WHALE_HOME,'recovered'))) return Response.json({code:-1})
        return ok({relation:{attribute:0},be_relation:{attribute:2}})
      }
      if (p.endsWith('/fetch_session_msgs')) {
        const id = u.searchParams.get('talker_id')
        return ok({has_more:0,messages:[id+'new',...(id==='301'?['old']:[])].map(key=>({msg_key:key,timestamp:200,sender_uid:id,content:'test'}))})
      }
      throw Error('Unexpected request')
    }
  `)
  const first = f.cli('--peek','--json')
  assert.equal(first.status, 0, first.stderr)
  const msg = JSON.parse(first.stdout)
  assert.equal(msg.key,'301new')
  assert.equal(read(f.stateFile).fanCursors['302'],undefined)
  assert.equal(f.cli('--ack',msg.receipt).status,0)
  assert.deepEqual(read(f.stateFile).fanCursors['301'].lastKeys,['old','301new'])
  write(path.join(f.dir,'recovered'),true)
  const recovered = f.cli('--json')
  assert.equal(recovered.status,0,recovered.stderr)
  assert.equal(JSON.parse(recovered.stdout).key,'302new')
  assert.equal(f.cli('--json').status,1)
})

test('comment inboxes page through their prior cursor and retry an unresolved follower without replaying the owner', async t => {
  const f = fixture({commentOwner:true,commentFan:true,allDay:true})
  const cursor = path.join(f.dir, 'state', 'listen-cursor.json')
  fs.mkdirSync(path.dirname(cursor), { recursive: true })
  const ts = 100
  write(cursor,{identity:{account:'100',owner:'200'},lastSeen:ts,lastIds:['reply:old']})
  let recovered = false, delayedMention = false
  const requests = [], delivered = []
  const item = (id,mid,ts) => ({id,reply_time:ts,user:{mid,nickname:mid},item:{source_content:id,subject_id:'10',source_id:id}})
  t.mock.method(globalThis,'fetch',async input=>{
    const u=new URL(input), key=u.searchParams.get('cursor')
    const feed=(items,cursor)=>Response.json({code:0,data:{items,cursor}})
    if(u.pathname.endsWith('/reply')) {
      requests.push(key)
      if(key==='second')return feed([item('second','200',ts),item('old','200',ts),item('prior','200',ts-1)],'past')
      assert.notEqual(key,'past','should stop beyond the prior timestamp')
      return feed([item('owner','200',ts+2),item('fan','303',ts+1)],'second')
    }
    if(u.pathname.endsWith('/at'))return feed(delayedMention ? [item('mention','200',ts)] : [])
    if(u.pathname.includes('/relation'))return recovered?Response.json({code:0,data:{relation:{attribute:0},be_relation:{attribute:2}}}):Response.json({code:-1})
    throw Error('Unknown fixture request')
  })
  const poll = async () => {
    const controller={prompt(){},async createAndPrompt(input){delivered.push(input.content[0].text);return {sessionId:'fixture'}}}
    const sched=startScheduler({sessionController:controller},{whaleHome:f.dir,cwd:f.dir,biliMjs:'unused',credentialsFile:f.credentialsFile})
    try { await sched.listenTick() } finally { sched.stop() }
  }
  await poll()
  assert.ok(requests.includes('second'))
  assert.equal(delivered.length,1)
  assert.match(delivered[0],/parent=second/)
  assert.match(delivered[0],/parent=owner/)
  assert.doesNotMatch(delivered[0],/parent=fan/)
  f.config.listen.commentFan = false
  f.save()
  await poll()
  assert.equal(delivered.length,1)
  f.config.listen.commentFan = true
  f.save()
  recovered=true
  await poll()
  assert.equal(delivered.length,2)
  assert.match(delivered[1],/parent=fan/)
  assert.doesNotMatch(delivered[1],/parent=owner|parent=second/)
  await poll()
  assert.equal(delivered.length,2)
  delayedMention = true
  await poll()
  assert.equal(delivered.length,3)
  assert.match(delivered[2],/parent=mention/)
})

test('finishing a resumed scan containing only a known same-second ID clears the saved cursor', async t => {
  const f = fixture({commentOwner:true,allDay:true})
  const file = path.join(f.dir, 'state', 'listen-cursor.json')
  fs.mkdirSync(path.dirname(file), { recursive: true })
  write(file,{identity:{account:'100',owner:'200'},lastSeen:100,lastIds:['reply:9'],scan:{reply:{items:[],cursor:'final'}}})
  const queries = []
  t.mock.method(globalThis,'fetch',async input=>{
    const url = new URL(input)
    if(url.pathname.endsWith('/reply'))queries.push(url.searchParams.get('cursor'))
    const items = url.pathname.endsWith('/reply') ? [{id:9,reply_time:100,user:{mid:200},item:{source_content:'read'}}] : []
    return Response.json({code:0,data:{items}})
  })
  for(let i=0;i<2;i++) {
    const scheduler=startScheduler({sessionController:{prompt(){},async createAndPrompt(){throw Error('Known ID must not deliver')}}},
      {whaleHome:f.dir,cwd:f.dir,biliMjs:'unused',credentialsFile:f.credentialsFile})
    try { await scheduler.listenTick() } finally { scheduler.stop() }
  }
  assert.deepEqual(queries,['final',null])
  assert.equal(read(file).lastSeen,100)
})

test('a closed thread whose host rejected the prompt can retry the same notification during cooldown', async t => {
  const f=fixture({commentOwner:true,allDay:true})
  f.config.life={enabled:true,cooldownMinutes:10}
  f.save()
  const {createLifeStore}=await import('../../src/life/store.mjs')
  const oldStore=createLifeStore({whaleHome:f.dir,account:'100',owner:'200',config:f.config.life,now:()=>Date.now()-86400000})
  await oldStore.closeThread('1:44:55')
  const cursor=path.join(f.dir, 'state', 'listen-cursor.json')
  fs.mkdirSync(path.dirname(cursor), { recursive: true })
  write(cursor,{identity:{account:'100',owner:'200'},lastSeen:100})
  t.mock.method(globalThis,'fetch',async input=>Response.json({code:0,data:{items:new URL(input).pathname.endsWith('/reply') ? [
    {id:41,reply_time:101,user:{mid:200},item:{subject_id:44,source_id:55,source_content:'retry fixture'}}
  ] : []}}))
  let attempts=0
  const controller={prompt(){},async createAndPrompt(){attempts++;if(attempts===1)throw Error('Host rejected before accepting');return {sessionId:'retried'}}}
  for(let i=0;i<2;i++) {
    const scheduler=startScheduler({sessionController:controller},{whaleHome:f.dir,cwd:f.dir,biliMjs:'unused',credentialsFile:f.credentialsFile})
    try { await scheduler.listenTick() } finally { scheduler.stop() }
    assert.equal(read(cursor).lastSeen,i===0?100:101)
  }
  assert.equal(attempts,2)
})

test('a fallback that only describes outgoing following leaves the incoming follower status unknown', async () => {
  const { checkRelation } = await import('../../src/bili/relation.mjs')
  const response = await checkRelation('859',{}, {fresh:true,fetchImpl:async input=>Response.json(
    new URL(input).pathname.includes('/space/') ? {code:-1} : {code:0,data:{attribute:0}})})
  assert.equal(response.ok,false)
  assert.equal(response.isFollower,false)
})

test('a bounded inbox scan resumes a structured platform cursor after restart without dropping unread pages', async t => {
  const f = fixture({commentOwner:true,allDay:true})
  const cursor = path.join(f.dir, 'state', 'listen-cursor.json')
  fs.mkdirSync(path.dirname(cursor), { recursive: true })
  write(cursor,{identity:{account:'100',owner:'200'},lastSeen:100})
  const pages=[], sends=[]
  t.mock.method(globalThis,'fetch',async input=>{
    const u = new URL(input)
    if(u.pathname.endsWith('/at'))return Response.json({code:0,data:{items:[]}})
    const page=Number(u.searchParams.get('id') || 1)
    pages.push(page)
    assert.ok(page>=1 && page<=12)
    if(page>1)assert.equal(u.searchParams.get('reply_time'),String(200-page+1))
    return Response.json({code:0,data:{items:[{id:page,reply_time:200-page,user:{mid:200},item:{source_content:'test'+page,source_id:page,subject_id:page}}],
      cursor:{is_end:page===12,id:page+1,time:200-page}}})
  })
  const poll=async () => {
    const controller={prompt(){},async createAndPrompt(info){sends.push(info);return {sessionId:'test'}}}
    const sched=startScheduler({sessionController:controller},{whaleHome:f.dir,cwd:f.dir,biliMjs:'unused',credentialsFile:f.credentialsFile})
    try { await sched.listenTick() } finally { sched.stop() }
  }
  await poll()
  assert.equal(sends.length,0)
  assert.equal(read(cursor).lastSeen,100)
  for(let i=0;i<12 && sends.length<2;i++)await poll()
  assert.deepEqual(pages.slice(0,12),Array.from({length:12},(_,i)=>i+1))
  assert.equal(sends.length,2)
  const coordinates = sends.flatMap(send => [...send.content[0].text.matchAll(/parent=(\d+)  type=/g)].map(match => Number(match[1])))
  assert.deepEqual(coordinates,Array.from({length:12},(_,i)=>12-i))
  assert.equal(read(cursor).lastSeen,199)
})

test('digest uses each inbox read time in both orders', () => {
  const f = fixture({})
  const digest = (...args) => f.run('src/cli/commands/comment-digest.mjs','--only-unread','--raw','--json',...args)
  for (const unread of ['reply','at']) {
    fs.writeFileSync(f.shim,`globalThis.fetch=async input=>{
      const kind=new URL(input).pathname.split('/').pop(), recent=Math.floor(Date.now()/1000)
      return Response.json({code:0,data:{last_view_at:recent-(kind==='${unread}'?60:10),items:[{id:1,reply_time:recent-30,user:{mid:200},item:{source_content:'test'}}]}})
    }`)
    const result=digest()
    assert.equal(result.status,0,result.stderr)
    assert.deepEqual(JSON.parse(result.stdout).items.map(x=>x.kind),[unread])
  }
})

test('thread links and parent coordinates retain integer precision and prefer canonical string IDs', () => {
  const f=fixture({})
  fs.writeFileSync(f.shim,`globalThis.fetch=async()=>new Response('{"code":0,"data":{"root":{"rpid":9007199254740993},"replies":[{"rpid":10,"rpid_str":"9007199254740995","parent":9007199254740993}]}}')`)
  const thread=f.run('src/cli/verify/thread.mjs','1','BV0000000001','9007199254740993')
  assert.equal(thread.status,0,thread.stderr)
  assert.match(thread.stdout,/rpid=9007199254740995  parent=9007199254740993/)
  assert.match(thread.stdout,/#reply9007199254740993/)
})

test('only the manual wake that obtained the lease reports a successful request ID', async () => {
  const f=fixture({})
  const calls=[]
  const controller={prompt(){},async createAndPrompt(info){calls.push(info);return {sessionId:'manual'}}}
  const sched=startScheduler({sessionController:controller},{whaleHome:f.dir,cwd:f.dir,biliMjs:'unused',credentialsFile:f.credentialsFile})
  try {
    const result=await Promise.allSettled([sched.wakeNow(),sched.wakeNow()])
    assert.equal(calls.length,1)
    assert.equal(result.filter(r=>r.status==='fulfilled' && r.value?.ok && r.value.requestId).length,1)
    assert.equal(result.filter(r=>r.status==='rejected').length,1)
  } finally { sched.stop() }
})

test('owner likes filter returns matching notifications while retaining an explicit unfiltered total', () => {
  const f = fixture({})
  fs.writeFileSync(f.shim,`globalThis.fetch=async()=>Response.json({code:0,data:{latest:{items:[200,300].map((mid,i)=>({
    id:i+1,like_time:Math.floor(Date.now()/1000),users:[{mid}]
  }))}}})`)
  const likes = (...args) => {
    const result = f.run('src/cli/commands/likes.mjs','--json',...args)
    assert.equal(result.status,0,result.stderr)
    return JSON.parse(result.stdout)
  }
  const owner = likes('--owner')
  assert.deepEqual(owner.items.map(x=>x.id),[1])
  assert.equal(owner.total,2)
  assert.equal(owner.count,1)
  assert.equal(owner.ownerLiked,1)
  const all = likes()
  assert.deepEqual(all.items.map(x=>x.id),[1,2])
  assert.equal(all.count,all.total)
})
