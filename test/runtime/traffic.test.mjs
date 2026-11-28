/**
 * B 站请求保护回归测试：验证限流冷却、人工暂停与跨进程状态读取。
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { createTrafficGuard, RISK_DEFAULTS } from '../../src/bili/traffic.mjs'

const start = Date.UTC(2026, 10, 28, 5)
const headers = { cookie: 'SESSDATA=fixture-whale' }
const loginUrl = 'https://api.bilibili.com/x/web-interface/nav'

function fixture(t, transport) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-traffic-test-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  let time = start
  const advance = ms => { time += ms }
  const open = () => createTrafficGuard({
    directory, transport, now: () => time, sleep: async ms => advance(ms),
    settings: () => ({ ...RISK_DEFAULTS, minGapMs: 0, writeGapSec: 0 }),
  })
  return { open, advance }
}

test('10031 persists a cooldown and blocks other requests until Retry-After expires', async t => {
  const { open, advance } = fixture(t, async url => url === loginUrl
    ? Response.json({ code: 0 })
    : Response.json({ code: 10031 }, { headers: { 'Retry-After': '900' } }))
  await open().fetch('https://api.bilibili.com/x/v3/fav/resource/deal?csrf=fixture-secret', {
    method: 'POST', headers, body: 'rid=123',
  })

  const guard = open()
  await assert.rejects(guard.fetch(loginUrl, { headers }), {
    code: 'BILI_TRAFFIC_PAUSED', message: /【收藏视频】触发请求限流/,
  })
  const { cooldown, manual } = guard.pauseStatus(headers)
  assert.equal(cooldown.until, start + 900_000)
  assert.equal(cooldown.endpoint, '/x/v3/fav/resource/deal')
  assert.equal(cooldown.method, 'POST')
  assert.equal(cooldown.code, 10031)
  assert.equal(cooldown.summary, '触发请求限流')
  assert.equal(manual, null)
  advance(899_999)
  await assert.rejects(guard.fetch(loginUrl, { headers }), { code: 'BILI_TRAFFIC_PAUSED' })
  advance(1)
  assert.equal((await (await guard.fetch(loginUrl, { headers })).json()).code, 0)
  assert.equal(guard.pauseStatus(headers).cooldown, null)
})

test('12051 pauses the affected session until it is reviewed and manually resumed', async t => {
  const { open, advance } = fixture(t, async url => Response.json({ code: url === loginUrl ? 0 : 12051 }))
  await open().fetch('https://api.bilibili.com/x/v2/reply/add?w_rid=fixture-secret', {
    method: 'POST', headers, body: 'message=fixture',
  })

  advance(7_200_000)
  const guard = open()
  await assert.rejects(guard.fetch(loginUrl, { headers }), {
    code: 'BILI_TRAFFIC_PAUSED', message: /【发表评论或回复】触发重复评论限制/,
  })
  const otherHeaders = { cookie: 'SESSDATA=fixture-other' }
  assert.equal((await (await guard.fetch(loginUrl, { headers: otherHeaders })).json()).code, 0)
  assert.equal(guard.pauseStatus(otherHeaders).manual, null)
  const { manual, cooldown } = guard.pauseStatus(headers)
  assert.equal(manual.endpoint, '/x/v2/reply/add')
  assert.equal(manual.method, 'POST')
  assert.equal(manual.code, 12051)
  assert.equal(manual.summary, '触发重复评论限制')
  assert.equal(cooldown, null)

  await guard.resume(headers)
  assert.equal(open().pauseStatus(headers).manual, null)
  assert.equal((await (await open().fetch(loginUrl, { headers })).json()).code, 0)
})
