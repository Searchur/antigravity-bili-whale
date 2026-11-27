/**
 * CLI 命令回归测试：覆盖写前预检、粉丝限额锁、图片校验、观片时长硬检查与自主评论配额。
 */
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import test from 'node:test'
import { fanCommentQuota } from '../../src/social/mention-summary.mjs'
import { evaluateModelQuota } from '../../src/host/model-quota-guard.mjs'
import { createSafetyReviewer } from '../../src/daemon/safety-worker.mjs'
import { startSidecarIpc } from '../../src/host/sidecar-ipc.mjs'
import { createModelToolRunner } from '../../src/mcp/model-tools.mjs'
import { checkFanQuota, lockFanReplyQuota, recordFanReply } from '../../src/social/fan-quota.mjs'
import { uploadPic } from '../../src/bili/upload-pic.mjs'

const exec = promisify(execFile)
const cli = fileURLToPath(new URL('../../src/cli/bili.mjs', import.meta.url))

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-runtime-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const env = { ...process.env, BILI_WHALE_HOME: dir, BILI_WHALE_CONFIG: path.join(dir, 'config.json') }
  return { dir, env }
}

test('comment-delete requires a matching single-use preview before a write', async t => {
  const { dir, env } = fixture(t)
  fs.writeFileSync(path.join(dir, 'credentials.json'), JSON.stringify({ sessdata: 'test-session-only', bili_jct: 'a'.repeat(32) }))
  const calls = path.join(dir, 'calls.txt')
  const stub = `import fs from 'node:fs'; globalThis.fetch = async (url, options) => {
    if (String(url) !== 'https://api.bilibili.com/x/v2/reply/del' || options.method !== 'POST') throw Error('Unexpected remote request');
    fs.appendFileSync(${JSON.stringify(calls)}, 'post\\n');
    return Response.json({code:0});
  };`
  const preload = `data:text/javascript;base64,${Buffer.from(stub).toString('base64')}`
  const run = (rpid, mode) => exec(process.execPath, ['--import', preload, cli, 'comment-del', '--oid', '10', '--rpid', rpid, mode], {
    env: { ...env, NODE_OPTIONS: `--import=${preload}` },
    timeout: 10_000,
  })
  const noPreview = error => /缺少匹配的预览/.test(error.stderr)
  await assert.rejects(run('20', '--go'), noPreview)
  await run('20', '--dry')
  await assert.rejects(run('21', '--go'), noPreview)
  assert.equal(fs.existsSync(calls), false)
  await run('20', '--go')
  await assert.rejects(run('20', '--go'), noPreview)
  assert.equal(fs.readFileSync(calls, 'utf8'), 'post\n')
})

test('night command dry-run and execution share the UI wake endpoint', async t => {
  const { dir, env } = fixture(t)
  let wakes = 0
  const ipc = await startSidecarIpc({
    file: path.join(dir, 'runtime', 'sidecar-ipc.json'),
    protect: () => {},
    getStatus: () => ({ schedulerStatus: { rpcAvailable: true } }),
    onWakeNow: () => ({ requestId: `test-wake-${++wakes}` }),
  })
  try {
    const run = mode => exec(process.execPath, [cli, 'night', 'trigger', mode], { env, timeout: 10_000 })
    const preview = JSON.parse((await run('--dry')).stdout)
    assert.equal(preview.dry, true)
    assert.equal(wakes, 0)
    const result = JSON.parse((await run('--go')).stdout)
    assert.equal(result.requestId, 'test-wake-1')
  } finally {
    await ipc.close()
  }
})

test('the depleted Worker controls protection even when the main model has quota', () => {
  const catalog = { source: 'live', models: [
    { id: 'gemini-flash', label: 'Flash', remainingFraction: 0.9 },
    { id: 'gemini-flash-lite', label: 'Flash Lite', remainingFraction: 0 },
  ] }
  const status = evaluateModelQuota(catalog, { main: 'flash', worker: 'flash_lite', minQuotaPercent: 20 })
  assert.equal(status.paused, true)
  assert.equal(status.modelId, 'gemini-flash-lite')
})

test('fan summaries and ordinary replies have independent limits', async t => {
  const { dir } = fixture(t)
  const cfg = { listen: { mentionSummaryFan: true }, fanLimits: { mentionPerUserDaily: 1, commentPerUserDaily: 2 } }
  const summary = fanCommentQuota(cfg, { mid: '123', kind: 'at', text: '请概括这个视频' }, dir)
  const ordinary = fanCommentQuota(cfg, { mid: '123', kind: 'reply', text: '这个真有意思' }, dir)
  assert.equal(summary.channel, 'mentionSummary')
  assert.equal(ordinary.channel, 'comment')
  assert.equal(fanCommentQuota(cfg, { mid: '123', kind: 'reply', text: '银行开着吗' }, dir).channel, 'comment')
  // 粉丝不再设置确认回复档，回复消息按普通粉丝评论计入配额。
  assert.equal(fanCommentQuota(cfg, { mid: '123', kind: 'reply', text: '看吧！', quotedText: '确认要我看并总结吗？' }, dir).channel, 'comment')
  const release = await lockFanReplyQuota(summary)
  await assert.rejects(lockFanReplyQuota(summary))
  recordFanReply(summary)
  await release()
  await assert.rejects(lockFanReplyQuota(summary), /已达回复上限/)
  assert.equal(checkFanQuota(ordinary).allowed, true)
})

test('invalid model verdicts are not counted as successful reviews', async () => {
  const completeImpl = Object.assign(async () => '{"decision":"invalid"}', { available: () => true })
  const reviewer = createSafetyReviewer({ completeImpl })
  assert.equal((await reviewer.review({ text: '合成测试内容' })).checked, false)
  assert.equal(reviewer.status().checkedCount, 0)
})

test('model DM requires the task account and explicit recipient', async t => {
  const { dir, env } = fixture(t)
  fs.writeFileSync(env.BILI_WHALE_CONFIG, JSON.stringify({ self: { mid: '100' }, owner: { mid: '300' } }))
  fs.writeFileSync(path.join(dir, 'credentials.json'), JSON.stringify({ sessdata: 'test-session-only', bili_jct: 'a'.repeat(32) }))
  const run = createModelToolRunner({ whaleHome: dir, cfgFile: env.BILI_WHALE_CONFIG })
  const missing = await run('bili_write', { command: 'dm', args: ['--msg', 'fixture', '--dry'] })
  assert.equal(missing.isError, true)
  assert.match(missing.content[0].text, /--account/)
  const oldOwner = await run('bili_write', { command: 'dm', args: ['--account', '100', '--to', '299', '--msg', 'fixture', '--dry'] })
  assert.equal(oldOwner.isError, true)
  assert.match(oldOwner.content[0].text, /禁止主动向非主人发送私信/)
})

test('changed attachment is rejected before the upload transport', async t => {
  const { dir } = fixture(t)
  const attachment = path.join(dir, 'changed.png')
  fs.writeFileSync(attachment, 'synthetic new contents')
  await assert.rejects(uploadPic(attachment, 'fixture', {}, { expectedHash: '0'.repeat(64) }), /图片文件发生变化/)
})

test('debrief enforces configured duration limits per profile before fetching content', async t => {
  const { dir, env } = fixture(t)
  fs.writeFileSync(path.join(dir, 'credentials.json'), JSON.stringify({ sessdata: 'test-session-only', bili_jct: 'a'.repeat(32), buvid3: 'b3' }))
  fs.writeFileSync(env.BILI_WHALE_CONFIG, JSON.stringify({
    self: { mid: '100', name: '大鲸鱼' },
    owner: { mid: '300', name: '主人' },
    watch: {
      auto: { maxDurationMin: 10, minDurationSec: 60 },
      ownerMention: { autoMaxMin: 10, confirmMaxMin: 20 },
      fanMention: { autoMaxMin: 5 },
    },
  }))
  const stub = `globalThis.fetch = async (url) => {
    const u = String(url);
    if (u.includes('/x/web-interface/nav')) return Response.json({ code: 0, data: { wbi_img: { img_url: 'https://x/abcdef0123456789abcdef0123456789.png', sub_url: 'https://x/0123456789abcdef0123456789abcdef.png' } } });
    if (u.includes('bvid=BV1long00001')) return Response.json({ code: 0, data: { bvid: 'BV1long00001', aid: 1, cid: 2, title: '长视频测试', duration: 900, owner: { mid: 9, name: 'UP' }, stat: {} } });
    if (u.includes('bvid=BV1short0001')) return Response.json({ code: 0, data: { bvid: 'BV1short0001', aid: 2, cid: 3, title: '超短视频测试', duration: 20, owner: { mid: 9, name: 'UP' }, stat: {} } });
    throw Error('Unexpected fetch after duration guard: ' + u);
  };`
  const preload = `data:text/javascript;base64,${Buffer.from(stub).toString('base64')}`
  const runDebrief = (...args) => exec(process.execPath, ['--import', preload, cli, 'debrief', ...args], {
    env: { ...env, NODE_OPTIONS: `--import=${preload}` },
    timeout: 10_000,
  })
  await assert.rejects(runDebrief('BV1long00001', '--profile', 'auto'), /超过自主观看最长时长限制（10 分钟）/)
  await assert.rejects(runDebrief('BV1short0001', '--profile', 'auto'), /低于自主观看最短时长限制/)
  await assert.rejects(runDebrief('BV1long00001', '--profile', 'owner'), /询问确认/)
  await assert.rejects(runDebrief('BV1long00001', '--profile', 'fan'), /超过粉丝 @ 观看上限（5 分钟）/)
  await assert.rejects(runDebrief('BV1long00001', '--no-frames'), /已移除.*--no-frames/)
})

test('quota enforces autoComment toggle, daily cap, and 7-day same-video dedup', async t => {
  const { dir, env } = fixture(t)
  const runQuota = (...args) => exec(process.execPath, [cli, 'quota', ...args], { env, timeout: 10_000 })

  // 开启自主评论且每日上限为 2
  fs.writeFileSync(env.BILI_WHALE_CONFIG, JSON.stringify({ chat: { autoComment: true, autoCommentDailyMax: 2 } }))
  const ok1 = await runQuota('check', '--type', 'comment', '--target', 'BV:BV1aaa000001', '--auto')
  assert.match(ok1.stdout, /自主评论额度内（0\/2）/)
  await runQuota('record', '--type', 'comment', '--target', 'BV:BV1aaa000001', '--auto', '--note', '第一条')
  await assert.rejects(runQuota('check', '--type', 'comment', '--target', 'BV:BV1aaa000001', '--auto'), err => /7 天内已经自主评论过了/.test(err.stdout))
  await runQuota('record', '--type', 'comment', '--target', 'BV:BV1aaa000002', '--auto', '--note', '第二条')
  await assert.rejects(runQuota('check', '--type', 'comment', '--target', 'BV:BV1aaa000003', '--auto'), err => /今日自主评论额度已用完（2\/2）/.test(err.stdout))

  // 关闭自主评论后立即拦截
  fs.writeFileSync(env.BILI_WHALE_CONFIG, JSON.stringify({ chat: { autoComment: false, autoCommentDailyMax: 3 } }))
  await assert.rejects(runQuota('check', '--type', 'comment', '--target', 'BV:BV1aaa000004', '--auto'), /自主评论已关闭/)
})
