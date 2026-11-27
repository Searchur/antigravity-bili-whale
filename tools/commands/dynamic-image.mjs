import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { bundledStickerRoot, userStickerRoot, shotsPath, workDirPath } from '../lib/paths.mjs'
import { guardedFetch as fetch } from '../lib/traffic.mjs'
import { gate, lockQuotaForSend, flushQuotaReceipts } from '../lib/quota-gate.mjs'
import { uploadPic } from '../lib/upload-pic.mjs'
import { guardSend } from '../lib/life-runtime.mjs'
import { config } from '../lib/config.mjs'
import { enforceOutboundSafety } from '../lib/content-safety.mjs'
import { requireWritePreview } from '../lib/write-preview.mjs'
import { exactJson } from '../lib/json-exact.mjs'
import { loadCred, missingForWrite } from '../lib/cred.mjs'

function assertSafeImagePath(filePath) {
  const realTarget = fs.realpathSync(filePath)
  const allowedRoots = [
    shotsPath,
    workDirPath,
    userStickerRoot,
    bundledStickerRoot,
  ]
  const inside = allowedRoots.some(root => {
    try {
      const realRoot = fs.realpathSync(root)
      const rel = path.relative(realRoot, realTarget)
      return Boolean(rel) && !rel.startsWith('..') && !path.isAbsolute(rel)
    } catch { return false }
  })
  if (!inside) throw Error('图片路径不在允许目录内（仅限插件内置表情包或大鲸鱼数据目录下的图片）')
  const st = fs.statSync(realTarget)
  if (!st.isFile() || st.size <= 0 || st.size > 10 * 1024 * 1024) throw Error('图片文件无效或超过 10MB 上限')
  return realTarget
}

const argv = process.argv.slice(2)
const args = new Map()
for (let i = 0; i < argv.length; i += 1) {
  const a = argv[i]
  if (a.startsWith('--')) args.set(a.slice(2), argv[i + 1]?.startsWith('--') ? true : argv[++i] ?? true)
}
const imageRaw = args.get('image')
const text = typeof args.get('text') === 'string' ? args.get('text') : ''
const atMid = args.get('at')
const atName = args.get('at-name')
const isDry = args.has('dry')
const isGo = args.has('go')

if (!imageRaw || typeof imageRaw !== 'string') { console.error('需要 --image <路径>'); process.exit(2) }
if (isDry === isGo) { console.error('必须且只能给一个 --dry 或 --go'); process.exit(2) }

let imagePath
try { imagePath = assertSafeImagePath(imageRaw) }
catch (e) { console.error('✗ --image 校验失败：' + e.message); process.exit(2) }

const buf = fs.readFileSync(imagePath)
function kindOf(b) {
  if (b.length > 8 && b[0] === 0x89 && b.toString('latin1', 1, 4) === 'PNG') return 'png'
  if (b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'jpg'
  if (b.length > 6 && b.toString('latin1', 0, 3) === 'GIF') return 'gif'
  if (b.length > 12 && b.toString('latin1', 0, 4) === 'RIFF' && b.toString('latin1', 8, 12) === 'WEBP') return 'webp'
  return 'unknown'
}
function dimsOf(b, kind) {
  if (kind === 'png') return { width: b.readUInt32BE(16), height: b.readUInt32BE(20) }
  if (kind === 'gif') return { width: b.readUInt16LE(6), height: b.readUInt16LE(8) }
  if (kind === 'jpg') {
    let i = 2
    while (i + 9 < b.length) {
      if (b[i] !== 0xff) { i += 1; continue }
      const marker = b[i + 1]
      if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
        return { height: b.readUInt16BE(i + 5), width: b.readUInt16BE(i + 7) }
      }
      const len = b.readUInt16BE(i + 2)
      i += 2 + len
    }
    return null
  }
  return null
}
const kind = kindOf(buf)
const dims = dimsOf(buf, kind)
console.log('=== 图片 ===')
console.log(`  路径: ${imagePath}`)
console.log(`  类型: ${kind}   ${(buf.length / 1024).toFixed(1)} KiB   ${dims ? `${dims.width}x${dims.height}` : '尺寸未解析'}`)
if (!['png', 'jpg', 'gif'].includes(kind)) {
  console.error(`\n✗ 该接口只收 jpg / png / gif，当前是 ${kind}。请转换为 PNG 后重试。`)
  process.exit(5)
}
if (!dims) { console.error('✗ 没解析出尺寸，无法组装 pics'); process.exit(5) }

// 无条件校验公开动态开关与每日限额
if (!gate({ type: 'dynamic', target: 'dynamic', auto: true })) {
  console.error('拒绝：公开动态未开启或今日额度已用完')
  process.exit(2)
}

const safety = await enforceOutboundSafety({ text: [text, atName].filter(Boolean).join('\n'), channel: 'dynamic', cfg: config() })
if (safety.blocked) { console.error(safety.reason); process.exit(4) }

let cred
try {
  cred = loadCred()
  const miss = missingForWrite(cred)
  if (miss.length) { console.error(`凭据不完整，缺少：${miss.join('、')}`); process.exit(3) }
} catch (e) { console.error(e.message); process.exit(3) }

const cookieHeader = `SESSDATA=${cred.sessdata}; bili_jct=${cred.bili_jct}; buvid3=${cred.buvid3 ?? ''}`
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
const REF = 'https://t.bilibili.com/'

const MIXIN_TAB = [46,47,18,2,53,8,23,32,15,50,10,31,58,3,45,35,27,43,5,49,33,9,42,19,29,28,14,39,12,38,41,13,37,48,7,16,24,55,40,61,26,17,0,1,60,51,30,4,22,25,54,21,56,59,6,63,57,62,11,36,20,34,44,52]
const keyOf = (u) => u.slice(u.lastIndexOf('/') + 1, u.lastIndexOf('.'))
async function wbi(params) {
  const d = await (await fetch('https://api.bilibili.com/x/web-interface/nav', {
    headers: { 'user-agent': UA, referer: 'https://www.bilibili.com/', cookie: cookieHeader },
  })).json()
  const img = d?.data?.wbi_img?.img_url, sub = d?.data?.wbi_img?.sub_url
  if (!img || !sub) return ''
  const mixin = MIXIN_TAB.map((i) => (keyOf(img) + keyOf(sub))[i]).join('').slice(0, 32)
  const wts = Math.round(Date.now() / 1000)
  const clean = (v) => String(v).replace(/[!'()*]/g, '')
  const q = Object.keys({ ...params, wts }).sort()
    .map((k) => `${encodeURIComponent(k)}=${encodeURIComponent(clean(k === 'wts' ? wts : params[k]))}`).join('&')
  return `${q}&w_rid=${crypto.createHash('md5').update(q + mixin).digest('hex')}`
}

console.log('\n=== 登录态 ===')
const nav = await (await fetch('https://api.bilibili.com/x/web-interface/nav', {
  headers: { 'user-agent': UA, referer: 'https://www.bilibili.com/', cookie: cookieHeader },
})).json()
if (nav.code !== 0) { console.error(`  登录态无效 code=${nav.code} ${nav.message}`); process.exit(4) }
console.log(`  账号: ${nav.data.uname} (UID ${nav.data.mid})  手机绑定=${nav.data.mobile_verified ? '是' : '否'}`)

console.log('\n=== 计划 ===')
console.log('  1) POST https://api.bilibili.com/x/dynamic/feed/draw/upload_bfs')
console.log('  2) POST https://api.bilibili.com/x/dynamic/feed/create/dyn?wts=..&w_rid=..')
console.log(`     正文: ${text ? `「${text.replace(/\n/g, ' / ')}」(${text.length} 字)` : '（空）'}`)
if (atMid) console.log(`     @节点: raw_text="@${atName ?? ''} "  type=2  biz_id=${atMid}`)

const request = {
  channel: 'dynamic',
  quotaTarget: 'dynamic',
  scene: 'public-comment',
  target: String(nav.data?.mid ?? ''),
  text: String(text || '[图文动态]'),
  auto: true,
  share: false,
}
await guardSend(request, { dry: true })
requireWritePreview('dynamic-image', { request, atMid, atName }, { dry: isDry, credentials: cred, attachment: buf })
if (isDry) { console.log('\n[dry] 预检通过，未上传、未发布。'); process.exit(0) }

let guard = null
const releaseQuota = await lockQuotaForSend({ type: 'dynamic' })
try {
  guard = await guardSend(request)
  console.log('\n[1/2] 上传图片…')
  const { image_url: imgSrc, image_width: w, image_height: h, img_size: kb } = await uploadPic(
    imagePath, cred.bili_jct, { 'user-agent': UA, referer: REF, cookie: cookieHeader },
    { expectedHash: crypto.createHash('sha256').update(buf).digest('hex') },
  )
  console.log(`     image_url=${imgSrc}  ${w}x${h}  ${kb}KB`)

  console.log('\n[2/2] 发布图文动态…')
  const contents = []
  if (text) contents.push({ raw_text: (atMid && !/\s$/.test(text)) ? `${text}\n` : text, type: 1, biz_id: '' })
  if (atMid) contents.push({ raw_text: `@${atName ?? ''} `, type: 2, biz_id: String(atMid) })
  const dynReq = {
    pics: [{ img_src: imgSrc, img_width: w, img_height: h, img_size: kb }],
    scene: 2,
    meta: { app_meta: { from: 'create.dynamic.web', mobi_app: 'web' } },
  }
  if (contents.length) dynReq.content = { contents }
  const body = JSON.stringify({ dyn_req: dynReq })
  const qs = await wbi({ csrf: String(cred.bili_jct) }) || new URLSearchParams({ csrf: String(cred.bili_jct) }).toString()
  const r = await fetch(`https://api.bilibili.com/x/dynamic/feed/create/dyn?${qs}`, {
    method: 'POST',
    waitWriteMs: 180000,
    ...(guard ? { dispatch: invoke => guard.store.dispatch(guard.token, invoke) } : {}),
    headers: { 'user-agent': UA, referer: REF, origin: 'https://t.bilibili.com', 'content-type': 'application/json', cookie: cookieHeader },
    body,
  })
  const out = await exactJson(r).catch(() => null)
  if (!out || typeof out.code !== 'number') throw Error('发布结果未知，请先回读核查')
  console.log(`     HTTP ${r.status}  code=${out.code}`)
  if (r.ok && out.code === 0) {
    const id = out.data?.dyn_id_str ?? out.data?.dyn_id
    if (!id) throw Error('接口返回成功码但没有 dyn_id，结果未确认；请先回读核查')
    if (guard) await guard.store.settle(guard.token, { status: 'sent', receipt: String(id) })
    await flushQuotaReceipts(guard.store)
    console.log(`\n已发布  dyn_id=${id}`)
    console.log(`   https://t.bilibili.com/${id}`)
    process.exit(0)
  } else {
    if (guard && Number.isFinite(out.code)) await guard.store.settle(guard.token, { status: 'rejected' })
    console.log('  发布失败，请检查接口状态')
    process.exit(1)
  }
} catch (e) {
  if (guard) {
    try {
      const pending = guard.store.read().pending[guard.token]
      if (pending?.phase === 'prepared') await guard.store.settle(guard.token, { status: 'not-sent', verified: true })
    } catch {}
  }
  console.error('✗ ' + String(e?.message ?? e))
  process.exit(1)
} finally { await releaseQuota() }
