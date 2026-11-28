/**
 * B 站媒体下载与抽帧回归测试：离线校验 Range 续传、重定向和本地代理的隔离边界。
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fetchBiliMedia } from '../../src/bili/media.mjs'
import { downloadVideo } from '../../src/media/video-download.mjs'
import { segmentFrames } from '../../src/media/video-frames.mjs'

function tempDirectory(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-media-test-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  return directory
}

test('video download resumes after validated CDN redirects with public headers', async (t) => {
  const file = path.join(tempDirectory(t), 'video.mp4')
  const observed = []
  const result = await downloadVideo({ url: 'https://a.bilivideo.com/video?upsig=source-ticket', size: 3 }, file, {
    headers: {
      cookie: 'SESSDATA=fixture-cookie', authorization: 'Bearer fixture-token',
      'x-private': 'fixture', referer: 'https://www.bilibili.com/video/BV1fixture/?w_rid=fixture#fragment',
    },
    fetch: async (url, options) => {
      const h = new Headers(options.headers)
      const range = h.get('range')
      observed.push({ url: String(url), range, headers: [...h], redirect: options.redirect })
      if (new URL(url).hostname === 'a.bilivideo.com') {
        return new Response(null, { status: 302, headers: { location: 'https://b.bilivideo.cn/segment?upsig=redirect-ticket' } })
      }
      return range === 'bytes=0-'
        ? new Response('a', { status: 206, headers: { 'content-range': 'bytes 0-0/3', 'content-type': 'video/mp4' } })
        : new Response('bc', { status: 206, headers: { 'content-range': 'bytes 1-2/3', 'content-type': 'application/octet-stream' } })
    },
  })
  assert.deepEqual(result, { size: 3, attempts: 2 })
  assert.equal(fs.readFileSync(file, 'utf8'), 'abc')
  assert.deepEqual(observed.map(({ url, range }) => [url, range]), [
    ['https://a.bilivideo.com/video?upsig=source-ticket', 'bytes=0-'],
    ['https://b.bilivideo.cn/segment?upsig=redirect-ticket', 'bytes=0-'],
    ['https://a.bilivideo.com/video?upsig=source-ticket', 'bytes=1-'],
    ['https://b.bilivideo.cn/segment?upsig=redirect-ticket', 'bytes=1-'],
  ])
  for (const request of observed) {
    assert.equal(request.redirect, 'manual')
    assert.deepEqual(request.headers, [
      ['accept-encoding', 'identity'], ['range', request.range], ['referer', 'https://www.bilibili.com/video/BV1fixture/'],
    ])
  }
})

test('video download rejects a CDN lookalike before dispatch', async (t) => {
  const file = path.join(tempDirectory(t), 'video.mp4')
  let calls = 0
  await assert.rejects(downloadVideo({ url: 'https://video.bilivideo.com.fixture.invalid/video' }, file, {
    fetch: async () => { calls += 1; return new Response('invalid content') },
  }), /视频下载失败/)
  assert.equal(calls, 0)
  assert.equal(fs.existsSync(file), false)
})

test('video download never accepts a body larger than its declared range', async (t) => {
  const file = path.join(tempDirectory(t), 'video.mp4')
  await assert.rejects(downloadVideo({ url: 'https://a.bilivideo.com/video', size: 3 }, file, {
    fetch: async () => new Response('abc', { status: 206, headers: { 'content-range': 'bytes 0-0/3', 'content-type': 'video/mp4' } }),
  }), /视频下载失败/)
  assert.equal(fs.existsSync(file), false)
})

test('a change in total size restarts a partial download with unknown metadata size', async (t) => {
  const file = path.join(tempDirectory(t), 'video.mp4')
  const ranges = []
  const result = await downloadVideo({ url: 'https://a.bilivideo.com/video' }, file, {
    fetch: async (_url, options) => {
      ranges.push(new Headers(options.headers).get('range'))
      const [range, body] = [['0-0/3', 'a'], ['1-3/4', 'xyz'], ['0-3/4', 'wxyz']][ranges.length - 1]
      return new Response(body, { status: 206, headers: { 'content-range': 'bytes ' + range, 'content-type': 'video/mp4' } })
    },
  })
  assert.deepEqual(result, { size: 4, attempts: 3 })
  assert.deepEqual(ranges, ['bytes=0-', 'bytes=1-', 'bytes=0-'])
  assert.equal(fs.readFileSync(file, 'utf8'), 'wxyz')
})

test('both video readers reject JSON or HTML returned as a successful media response', async (t) => {
  const directory = tempDirectory(t)
  const file = path.join(directory, 'video.mp4')
  const url = 'https://a.bilivideo.com/video'
  const json = '{"code":-352}'
  await assert.rejects(downloadVideo({ url, size: json.length }, file, {
    fetch: async () => new Response(json, { headers: { 'content-type': 'application/json' } }),
  }), /视频下载失败/)
  assert.equal(fs.existsSync(file), false)

  const statuses = []
  await assert.rejects(segmentFrames({
    ffmpeg: 'unused-fixture-executable', url, times: [0], duration: 1, directory,
    transport: async () => new Response('<html></html>', { headers: { 'content-type': 'text/html' } }),
    run: async (_, args) => {
      const response = await fetch(args[args.indexOf('-i') + 1])
      statuses.push(response.status)
      await response.body.cancel()
      if (!response.ok) throw Error('抽帧输入不可用')
      fs.writeFileSync(args.at(-1).replace('%d', '1'), 'frame')
    },
  }), /分段抽帧失败/)
  assert.deepEqual(statuses, [502, 502])
})

test('media revalidates redirect targets and stops before dispatching an unsafe hop', async () => {
  for (const location of [
    'http://ai.hdslb.com/subtitle', 'https://ai.hdslb.com.fixture.invalid/subtitle',
    'https://ai.hdslb.com/subtitle?%77_rid=fixture-signature', 'https://fixture-user@ai.hdslb.com/subtitle',
  ]) {
    const calls = []
    await assert.rejects(fetchBiliMedia('//ai.hdslb.com/subtitle?auth_key=origin-ticket', {
      kind: 'subtitle',
      transport: async url => {
        calls.push(String(url))
        return new Response(null, { status: 302, headers: { location } })
      },
    }), { message: 'B 站媒体地址超出允许范围。' })
    assert.deepEqual(calls, ['https://ai.hdslb.com/subtitle?auth_key=origin-ticket'])
  }
})

test('segmented frames relay only the fixed video and permitted byte ranges', async (t) => {
  const directory = tempDirectory(t)
  const upstream = 'https://a.bilivideo.com/video?upsig=fixture'
  const calls = []
  let relay
  let checksPassed = false
  await segmentFrames({
    ffmpeg: 'unused-fixture-executable', url: upstream, times: [30], duration: 600, directory,
    transport: async (url, options) => {
      calls.push({ url: String(url), method: options.method, headers: new Headers(options.headers) })
      const head = options.method === 'HEAD'
      return new Response(head ? null : 'bc', {
        status: head ? 200 : 206,
        headers: { 'content-range': 'bytes 1-2/3', 'content-type': 'video/mp4', 'set-cookie': 'fixture-secret' },
      })
    },
    run: async (_, args) => {
      relay = args[args.indexOf('-i') + 1]
      assert.match(relay, /^http:\/\/127\.0\.0\.1:\d+\//)
      assert.equal(args.some(arg => arg.includes('upsig')), false)
      assert.equal((await fetch(new URL('/unrecognized', relay))).status, 404)
      assert.equal((await fetch(relay, { method: 'POST' })).status, 405)
      assert.equal((await fetch(relay, { headers: { range: 'bytes=0-2,5-8' } })).status, 416)
      const head = await fetch(relay, { method: 'HEAD' })
      assert.equal(head.status, 200)
      const response = await fetch(relay, { headers: { range: 'bytes=1-2', cookie: 'SESSDATA=abc', authorization: 'Bearer abc' } })
      assert.equal(response.status, 206)
      assert.equal(response.headers.get('content-range'), 'bytes 1-2/3')
      assert.equal(response.headers.get('set-cookie'), null)
      assert.equal(await response.text(), 'bc')
      checksPassed = true
      fs.writeFileSync(args.at(-1).replace('%d', '1'), 'frame')
    },
  })
  assert.equal(checksPassed, true)
  assert.equal(fs.readFileSync(path.join(directory, 'f00.jpg'), 'utf8'), 'frame')
  assert.deepEqual(calls.map(call => [call.url, call.method, call.headers.get('range')]), [
    [upstream, 'HEAD', null], [upstream, 'GET', 'bytes=1-2'],
  ])
  for (const call of calls) {
    assert.equal(call.headers.has('cookie'), false)
    assert.equal(call.headers.has('authorization'), false)
  }
  await assert.rejects(fetch(relay))
})
