/**
 * B 站只读 CLI 回归测试：验证签名请求与诊断输出，并检查视频评论坐标保真。
 */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const cli = fileURLToPath(new URL('../../src/cli/bili.mjs', import.meta.url))
const bvid = 'BV0000000001'
const imgKey = 'a'.repeat(32)
const subKey = 'b'.repeat(32)

function runRead(t, ...args) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-cli-read-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  if (args[0] === 'search') {
    fs.writeFileSync(path.join(dir, 'credentials.json'), JSON.stringify({ sessdata: 'fixture-read-session' }))
  }
  const platform = `
    import assert from 'node:assert/strict'
    globalThis.fetch = async (input, options) => {
      const url = new URL(input)
      assert.equal(url.origin, 'https://api.bilibili.com')
      if (url.pathname === '/x/web-interface/nav') {
        return Response.json({ code: -101, data: { wbi_img: {
          img_url: 'https://i0.hdslb.com/bfs/wbi/${imgKey}.png',
          sub_url: 'https://i0.hdslb.com/bfs/wbi/${subKey}.png',
        } } })
      }
      if (url.pathname === '/x/web-interface/wbi/view') {
        assert.equal(url.searchParams.get('bvid'), '${bvid}')
        assert.equal(url.searchParams.getAll('wts').length, 1)
        assert.match(url.searchParams.get('w_rid'), /^[a-f0-9]{32}$/)
        return new Response('{"code":0,"data":{"bvid":"${bvid}","aid":9007199254740993,"title":"测试视频","owner":{"name":"作者"},"stat":{},"pubdate":1700000000}}')
      }
      if (url.pathname === '/x/web-interface/wbi/search/type') {
        assert.equal(new Headers(options.headers).get('referer'), 'https://search.bilibili.com/')
        assert.equal(url.searchParams.get('search_type'), 'video')
        assert.equal(url.searchParams.get('page'), '2')
        assert.ok(url.search.includes('keyword=%E6%B5%8B%E8%AF%95%20%E7%A9%BA%E6%A0%BC~'))
        assert.equal(url.searchParams.getAll('w_rid').length, 1)
        return Response.json({ code: 0, data: { result: [] } })
      }
      if (url.pathname === '/x/v2/reply') {
        if (url.searchParams.get('oid') !== '9007199254740993') return Response.json({ code: -400 })
        return new Response('{"code":0,"data":{"replies":[{"rpid":9007199254740995,"member":{"mid":9007199254740997}}]}}')
      }
      throw Error('Unexpected Bilibili fixture route: ' + url.pathname)
    }
  `
  const preload = `data:text/javascript;base64,${Buffer.from(platform).toString('base64')}`
  const result = spawnSync(process.execPath, [cli, ...args], {
    env: {
      ...process.env,
      BILI_WHALE_HOME: dir,
      BILI_WHALE_CONFIG: path.join(dir, 'config.json'),
      BILI_TRAFFIC_TEST: '1',
      BILI_NO_CACHE: '1',
      NODE_OPTIONS: `--import=${preload}`,
    },
    encoding: 'utf8',
    timeout: 10_000,
  })
  if (result.error) throw result.error
  return result
}

test('recon reports WBI availability without printing signing material', t => {
  const result = runRead(t, 'recon', bvid)
  assert.equal(result.status, 0, result.stderr)
  assert.ok(!result.stdout.includes(imgKey))
  assert.ok(!result.stdout.includes(subKey))
  assert.doesNotMatch(result.stdout, /img_key|sub_key|mixin/i)
  assert.match(result.stdout, /WBI 签名.*（可用）/)
})

test('comments keeps unsafe integer video and comment coordinates exact', t => {
  const result = runRead(t, 'comments', bvid, '--json')
  assert.equal(result.status, 0, result.stderr || result.stdout)
  const report = JSON.parse(result.stdout)
  assert.equal(report.aid, '9007199254740993')
  assert.equal(report.items[0].rpid, '9007199254740995')
  assert.equal(report.items[0].mid, '9007199254740997')
})

test('search sends the signed keyword bytes with the original page and search type', t => {
  const result = runRead(t, 'search', '测试 空格~', '2')
  assert.equal(result.status, 0, result.stderr || result.stdout)
  assert.match(result.stdout, /page=2\s+code=0/)
})
