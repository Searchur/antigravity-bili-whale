/**
 * B 站公共请求层契约测试，使用隔离目录和模拟传输验证解析、缓存及保护状态。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-bili-contract-'))
process.env.BILI_WHALE_HOME = home
process.env.BILI_WHALE_CONFIG = path.join(home, 'config.json')
fs.writeFileSync(process.env.BILI_WHALE_CONFIG, JSON.stringify({ risk: { minGapMs: 0, writeGapSec: 0, dmGapSec: 0 } }))
delete process.env.BILI_NO_CACHE
delete process.env.BILI_TRAFFIC_TEST
const { apiGet, biliJson, requestBili, searchFeedVideos } = await import('../../src/bili/api.mjs')
const { createTrafficGuard } = await import('../../src/bili/traffic.mjs')
const { dataPathsFor } = await import('../../src/core/paths.mjs')

test('common Bili JSON keeps unsafe numeric identifiers exact', async t => {
  t.mock.method(globalThis, 'fetch', async () => new Response(
    '{"code":0,"data":{"id":9007199254740993}}',
    { headers: { 'content-type': 'application/json' } },
  ))
  const reply = await apiGet('https://api.bilibili.com/x/web-interface/nav', {}, { noCache: true })
  assert.equal(reply.data.id, '9007199254740993')
})

test('both legacy cooldown locations block guarded requests and preserve the last trigger', async () => {
  const directory = path.join(home, 'cooldowns')
  const paths = dataPathsFor(directory)
  const now = Date.now()
  fs.mkdirSync(path.dirname(paths.apiBan), { recursive: true })
  fs.writeFileSync(paths.legacyApiBan, JSON.stringify({ until: now + 60_000, endpoint: '/first' }))
  fs.writeFileSync(paths.apiBan, JSON.stringify({ until: now + 90_000, endpoint: '/second', why: 'fixture' }))
  const transport = async () => { throw Error('暂停期间不应触发传输') }
  const guard = createTrafficGuard({
    directory, now: () => now, transport,
  })
  assert.equal(guard.pauseStatus({}).cooldown.until, now + 90_000)
  assert.equal(guard.pauseStatus({}).cooldown.endpoint, '/second')
  await assert.rejects(guard.fetch('https://api.bilibili.com/x/web-interface/nav'), { code: 'BILI_TRAFFIC_PAUSED' })
  process.env.BILI_NO_CACHE = '1'
  try {
    await assert.rejects(requestBili('nav', { noCache: true, directory, transport }), { code: 'BILI_TRAFFIC_PAUSED' })
  } finally {
    delete process.env.BILI_NO_CACHE
  }
})

test('navigation cache isolates accounts and fresh verification bypasses hits', async () => {
  const directory = path.join(home, 'identity')
  let reads = 0
  const transport = async (_url, { headers }) => {
    const mid = headers.cookie === 'SESSDATA=fixture-a' ? 1 : 2
    return Response.json({ code: 0, data: { mid, version: ++reads } })
  }
  const options = { directory, transport, headers: { cookie: 'SESSDATA=fixture-a' } }
  const a = await requestBili('nav', options)
  const b = await requestBili('nav', { ...options, headers: { cookie: 'SESSDATA=fixture-b' } })
  const cached = await requestBili('nav', options)
  const fresh = await requestBili('nav', { ...options, noCache: true })
  assert.deepEqual([a.data.mid, b.data.mid, cached.source, fresh.data.version], [1, 2, 'cache', 3])
})

test('recommendation search cache isolates login sessions and respects the read cache switch', async () => {
  let calls = 0
  const criteria = { keyword: '测试推荐', order: 'pubdate', days: 7, account: '42' }
  const options = {
    directory: path.join(home, 'feed-cache'), headers: { cookie: 'SESSDATA=fixture-search-a' },
    keys: {
      img_url: '/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.png',
      sub_url: '/bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb.png',
    },
    transport: async url => {
      const { searchParams } = new URL(url)
      assert.equal(searchParams.get('keyword'), criteria.keyword)
      assert.equal(Number(searchParams.get('pubtime_end_s')) - Number(searchParams.get('pubtime_begin_s')), 7 * 86400)
      return Response.json({ code: 0, data: { version: ++calls } })
    },
  }
  assert.equal((await searchFeedVideos(criteria, options)).data.version, 1)
  assert.equal((await searchFeedVideos(criteria, options)).data.version, 1)
  assert.equal((await searchFeedVideos(criteria, { ...options, headers: { cookie: 'SESSDATA=fixture-search-b' } })).data.version, 2)
  process.env.BILI_NO_CACHE = '1'
  try { assert.equal((await searchFeedVideos(criteria, options)).data.version, 3) }
  finally { delete process.env.BILI_NO_CACHE }
  assert.equal((await searchFeedVideos(criteria, options)).data.version, 1)
})

test('metadata fallback preserves ordinary cooldown but exposes a simultaneous manual pause', async () => {
  for (const code of [10031, 12051]) {
    const directory = path.join(home, 'metadata-' + code)
    const headers = { cookie: 'SESSDATA=fixture-metadata' }
    const options = {
      directory, headers, ttlMs: 0, query: { aid: '9007199254740993' },
      keys: {
        img_url: '/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.png',
        sub_url: '/bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb.png',
      },
    }
    await requestBili('view', { ...options, transport: async () => Response.json({ code: 0, data: { title: '测试视频' } }) })
    const limited = await requestBili('view', { ...options,
      transport: async () => Response.json({ code }, { status: 429 }),
    })
    const { cooldown, manual } = createTrafficGuard({ directory }).pauseStatus(headers)
    assert.equal(cooldown.code, code)
    assert.equal(cooldown.label, '读取视频资料')
    if (code === 10031) {
      assert.equal(limited.source, 'stale')
      assert.equal(manual, null)
    } else {
      assert.equal(limited.ok, false)
      assert.equal(limited.kind, 'manual')
      assert.equal(limited.code, 12051)
      assert.equal(manual.code, 12051)
    }
  }
})

test('WBI preparation reports the navigation pause and never dispatches the signed lookup', async () => {
  const calls = []
  await assert.rejects(requestBili('search', {
    directory: path.join(home, 'signing-pause'), query: { keyword: '隔离夹具' },
    transport: async url => {
      calls.push(new URL(url).pathname)
      return Response.json({ code: 12051 })
    },
  }), error => error.code === 'BILI_TRAFFIC_PAUSED' && error.pause?.manual?.operation === 'nav')
  assert.deepEqual(calls, ['/x/web-interface/nav'])
})

test('transport failures classify timeouts without exposing the original exception', async () => {
  await assert.rejects(requestBili('nav', {
    directory: path.join(home, 'transport-error'),
    transport: async () => { throw new DOMException('SESSDATA=fixture-secret', 'TimeoutError') },
  }), error => {
    assert.equal(error.kind, 'timeout')
    assert.equal(error.code, 'BILI_REQUEST_TIMEOUT')
    assert.doesNotMatch(error.stack, /fixture-secret/)
    assert.equal(error.cause, undefined)
    return true
  })
})

test('a JSON platform error is surfaced on an XML endpoint', async () => {
  const directory = path.join(home, 'danmaku')
  const options = { directory, query: { cid: '9007199254740993' } }
  const normal = await requestBili('danmaku', { ...options,
    transport: async () => new Response('<i></i>', { headers: { 'content-type': 'text/xml' } }),
  })
  assert.equal(normal.ok, true)
  assert.equal(await normal.response.text(), '<i></i>')
  const limited = await requestBili('danmaku', { ...options,
    transport: async () => Response.json({ code: -352, message: '请求受限' }),
  })
  assert.equal(limited.ok, false)
  assert.equal(limited.kind, 'rate-limit')
  assert.equal(limited.code, -352)
  assert.equal(createTrafficGuard({ directory }).pauseStatus({}).cooldown.code, -352)
})

test('a non-successful HTTP response never provides playback data to JSON callers', async () => {
  const result = await biliJson('playUrl', {
    directory: path.join(home, 'playback-error'), query: { bvid: 'BV1fixture' },
    keys: {
      img_url: '/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.png',
      sub_url: '/bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb.png',
    },
    transport: async () => Response.json({ code: 0, data: { durl: [{ url: 'https://invalid.example/fixture' }] } }, { status: 503 }),
  })
  assert.equal(result.code, -1)
  assert.equal(result.data, undefined)
})

test('HTTP 503 with a success payload remains unconfirmed and cannot repeat', async () => {
  const directory = path.join(home, 'uncertain')
  let dispatched = 0
  const headers = { cookie: 'SESSDATA=fixture-write' }
  const options = {
    directory, headers, keys: null, body: new URLSearchParams({ oid: '9007199254740993', message: '测试' }),
    transport: async () => { dispatched++; return Response.json({ code: 0, message: 'fixture-write' }, { status: 503 }) },
  }
  const result = await requestBili('addComment', options)
  assert.equal(result.ok, false)
  assert.equal(result.rejected, false)
  assert.doesNotMatch(result.message, /fixture-write/)
  const state = createTrafficGuard({ directory }).status()
  assert.deepEqual(Object.values(state.operations).map(item => item.status), ['unknown'])
  await assert.rejects(requestBili('addComment', options), { code: 'BILI_TRAFFIC_PAUSED' })
  assert.equal(dispatched, 1)
})

test.after(() => fs.rmSync(home, { recursive: true, force: true }))
