import fs from 'node:fs'
import crypto from 'node:crypto'
import { requireWritePreview } from '../../social/write-preview.mjs'
import { guardedFetch as fetch } from '../../bili/traffic.mjs'
import { enforceOutboundSafety } from '../../social/content-safety.mjs'
import { gate, lockQuotaForSend, flushQuotaReceipts } from '../../social/quota-gate.mjs'
import { config } from '../../config/index.mjs'
import { guardSend } from '../../social/send-guard.mjs'
import { exactJson } from '../../core/json-exact.mjs'
import { loadCred, missingForWrite } from '../../bili/cred.mjs'

const argv = process.argv.slice(2)
const mode = argv[0]
const args = new Map()
for (let i = 1; i < argv.length; i += 1) {
  const a = argv[i]
  if (a.startsWith('--')) args.set(a.slice(2), argv[i + 1]?.startsWith('--') ? true : argv[++i] ?? true)
}
const isDry = args.has('dry')
const isGo = args.has('go')
const text = args.get('text')
const dynId = args.get('id')

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

async function whoami() {
  const d = await (await fetch('https://api.bilibili.com/x/web-interface/nav', {
    headers: { 'user-agent': UA, referer: 'https://www.bilibili.com/', cookie: cookieHeader },
  })).json()
  if (d.code !== 0) { console.log(`  登录态无效: code=${d.code} ${d.message}`); process.exit(4) }
  console.log(`  账号: ${d.data.uname} (UID ${d.data.mid})  手机绑定=${d.data.mobile_verified ? '是' : '否'}`)
  return d.data.mid
}

async function list(mid) {
  const u = `https://api.vc.bilibili.com/dynamic_svr/v1/dynamic_svr/space_history?host_uid=${mid}&offset_dynamic_id=0&need_top=0`
  const d = await (await fetch(u, { headers: { 'user-agent': UA, referer: REF, cookie: cookieHeader } })).json()
  console.log(`  space_history code=${d.code} ${d.message ?? ''}  卡片数=${(d.data?.cards ?? []).length}`)
  for (const c of (d.data?.cards ?? []).slice(0, 6)) {
    const desc = c.desc ?? {}
    let body = ''
    try { body = (JSON.parse(c.card).item?.description ?? JSON.parse(c.card).item?.content ?? '').slice(0, 60) } catch {}
    console.log(`    dyn_id=${desc.dynamic_id_str}  ${new Date((desc.timestamp ?? 0) * 1000).toLocaleTimeString('zh-CN')}  ${body}`)
  }
  return (d.data?.cards ?? []).map((c) => String(c.desc?.dynamic_id_str))
}

if (mode === 'list') {
  console.log('=== 当前空间动态 ===')
  const mid = await whoami()
  await list(mid)
  process.exit(0)
}

if (mode === 'post') {
  if (!text || typeof text !== 'string') { console.error('post 需要 --text'); process.exit(2) }
  if (isDry === isGo) { console.error('必须且只能给 --dry 或 --go'); process.exit(2) }
  const cfgNow = config()
  // 无条件校验公开动态开关与每日限额（即使不传 --auto 也绝不可绕过）
  if (!gate({ type: 'dynamic', target: 'dynamic', auto: true })) {
    console.error('拒绝：公开动态未开启或今日额度已用完')
    process.exit(2)
  }
  const safetyRes = await enforceOutboundSafety({ text, channel: 'dynamic', isOwnerTarget: false, cfg: cfgNow })
  if (safetyRes.blocked) {
    console.error(`✗ [安全审核拦截] ${safetyRes.reason}（类别：${safetyRes.category}）`)
    process.exit(4)
  }
  console.log('=== 登录态 ===')
  const mid = await whoami()
  const body = JSON.stringify({
    dyn_req: {
      content: { contents: [{ raw_text: text, type: 1, biz_id: '' }] },
      scene: 1,
      meta: { app_meta: { from: 'create.dynamic.web', mobi_app: 'web' } },
    },
  })
  const qs = await wbi({ csrf: String(cred.bili_jct) }) || new URLSearchParams({ csrf: String(cred.bili_jct) }).toString()
  const url = `https://api.bilibili.com/x/dynamic/feed/create/dyn?${qs}`
  console.log('\n=== 将要发布 ===')
  console.log('  POST https://api.bilibili.com/x/dynamic/feed/create/dyn?csrf=***&wts=...&w_rid=...')
  console.log('  content-type: application/json    cookie: SESSDATA=***; bili_jct=***; buvid3=***')
  console.log(`  正文(${text.length} 字): ${text}`)
  const request = { channel: 'dynamic', quotaTarget: 'dynamic', scene: 'public-comment', target: String(mid), text, auto: true, share: false }
  await guardSend(request, { dry: true })
  requireWritePreview('dynamic-post', request, { dry: isDry, credentials: cred })
  if (isDry) { console.log('\n[dry] 预检通过，未发布。'); process.exit(0) }
  let guard
  const releaseQuota = await lockQuotaForSend({ type: 'dynamic' })
  try {
    guard = await guardSend(request)
    const r = await fetch(url, {
      method: 'POST',
      waitWriteMs: 180000,
      ...(guard ? { dispatch: invoke => guard.store.dispatch(guard.token, invoke) } : {}),
      headers: { 'user-agent': UA, referer: REF, origin: 'https://t.bilibili.com', 'content-type': 'application/json', cookie: cookieHeader },
      body,
    })
    const out = await exactJson(r).catch(() => null)
    if (!out || typeof out.code !== 'number') throw Error('发送结果未知，请先回读核查')
    console.log(`\n[go] HTTP ${r.status}  code=${out.code}`)
    if (r.ok && out.code === 0) {
      const id = out.data?.dyn_id_str ?? out.data?.dyn_id
      if (id == null || !String(id)) throw Error('平台未返回动态回执，请先回读核查')
      if (guard) await guard.store.settle(guard.token, { status: 'sent', receipt: String(id) })
      await flushQuotaReceipts(guard.store)
      console.log(`  已发布  dyn_id=${id}`)
      console.log(`  https://t.bilibili.com/${id}`)
    } else {
      if (guard && out.code !== 0) await guard.store.settle(guard.token, { status: 'rejected' })
      console.log('  发布失败，请检查接口状态')
    }
    process.exit(r.ok && out.code === 0 ? 0 : 1)
  } catch (error) {
    if (guard && guard.store.read().pending[guard.token]?.phase === 'prepared') {
      await guard.store.settle(guard.token, { status: 'not-sent', verified: true })
    }
    console.error(error.message)
    process.exit(1)
  } finally { await releaseQuota() }
}

if (mode === 'check') {
  if (!dynId) { console.error('check 需要 --id <dyn_id>'); process.exit(2) }
  await whoami()
  const qs = await wbi({ id: String(dynId), features: 'itemOpusStyle' }) || new URLSearchParams({ id: String(dynId), features: 'itemOpusStyle' }).toString()
  const r = await fetch(`https://api.bilibili.com/x/polymer/web-dynamic/v1/detail?${qs}`, {
    headers: { 'user-agent': UA, referer: `${REF}${dynId}`, cookie: cookieHeader },
  })
  const ct = r.headers.get('content-type') ?? ''
  if (!ct.includes('json')) {
    console.log(`  detail 端点返回 ${ct || '未知类型'}，无法用它判定（不代表动态不存在）`)
    process.exit(0)
  }
  const d = await r.json()
  console.log(`  detail code=${d.code} ${d.message ?? d.msg ?? ''}`)
  if (d.code === 0) {
    const it = d.data?.item ?? {}
    console.log(`  存在  id=${it.id_str}  作者=${it.modules?.module_author?.name}  时间=${it.modules?.module_author?.pub_time}`)
    const dynamic = it.modules?.module_dynamic
    const t = dynamic?.desc?.text ?? dynamic?.major?.opus?.summary?.text
    if (typeof t === 'string') console.log(`  正文: ${t}`)
    else console.log('  正文未返回，无法确认正文内容')
    const pics = dynamic?.major?.opus?.pics ?? dynamic?.major?.draw?.items
    if (Array.isArray(pics)) console.log(`  图片: ${pics.length} 张`)
  } else {
    console.log('  未取到（可能已删除或权限受限）')
  }
  process.exit(0)
}

if (mode === 'rm') {
  if (!dynId) { console.error('rm 需要 --id <dyn_id>'); process.exit(2) }
  if (isDry === isGo) { console.error('必须且只能给 --dry 或 --go'); process.exit(2) }
  console.log('=== 登录态 ===')
  await whoami()
  console.log(`\n=== 将要删除 dyn_id=${dynId} ===`)
  console.log('  POST https://api.vc.bilibili.com/dynamic_svr/v1/dynamic_svr/rm_dynamic  (multipart/form-data)')
  console.log('  fields: dynamic_id / csrf / csrf_token   cookie: SESSDATA=***; bili_jct=***')
  requireWritePreview('dynamic-delete', { dynId }, { dry: isDry, credentials: cred })
  if (isDry) { console.log('\n[dry] 未删除。'); process.exit(0) }
  const fd = new FormData()
  fd.append('dynamic_id', String(dynId))
  fd.append('csrf', String(cred.bili_jct))
  fd.append('csrf_token', String(cred.bili_jct))
  const r = await fetch('https://api.vc.bilibili.com/dynamic_svr/v1/dynamic_svr/rm_dynamic', {
    method: 'POST',
    headers: { 'user-agent': UA, referer: REF, cookie: cookieHeader },
    body: fd,
  })
  const out = await exactJson(r).catch(() => ({ code: -1 }))
  const hints = { 0: '成功', '-101': '账号未登录', 500404: '已经删除过该动态', 500406: '动态不是自己的' }
  console.log(`\n[go] HTTP ${r.status}  code=${out.code} ${out.message ?? out.msg ?? ''}`)
  console.log(`  ${hints[out.code] ?? ''}`)
  process.exit(r.ok && out.code === 0 ? 0 : 1)
}

console.error('用法: list | post --text "..." --dry|--go | check --id <dyn_id> | rm --id <dyn_id> --dry|--go')
process.exit(2)
