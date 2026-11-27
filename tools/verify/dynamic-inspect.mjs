import fs from 'node:fs'
import { createHash } from 'node:crypto'
import { dataPath } from '../lib/paths.mjs'
import { guardedFetch as fetch } from '../lib/traffic.mjs'

const dynId = String(process.argv[2] ?? '').trim()
if (!/^\d{5,30}$/.test(dynId)) { console.error('用法: node dynamic-inspect.mjs <dynId>'); process.exit(2) }
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
let cookie = ''
try {
  const cred = JSON.parse(fs.readFileSync(dataPath('credentials.json'), 'utf8'))
  if (cred?.sessdata) cookie = `SESSDATA=${cred.sessdata}; bili_jct=${cred.bili_jct ?? ''}; buvid3=${cred.buvid3 ?? ''}`
} catch {}
const baseHeaders = { 'user-agent': UA, referer: 'https://www.bilibili.com/', ...(cookie ? { cookie } : {}) }

const nav = await (await fetch('https://api.bilibili.com/x/web-interface/nav', { headers: baseHeaders })).json()
const img = nav?.data?.wbi_img?.img_url, sub = nav?.data?.wbi_img?.sub_url
if (!img || !sub) { console.error('✗ 无法获取 WBI 签名密钥，请稍后重试'); process.exit(4) }
const TAB = [46,47,18,2,53,8,23,32,15,50,10,31,58,3,45,35,27,43,5,49,33,9,42,19,29,28,14,39,12,38,41,13,37,48,7,16,24,55,40,61,26,17,0,1,60,51,30,4,22,25,54,21,56,59,6,63,57,62,11,36,20,34,44,52]
const keyOf = (u) => u.slice(u.lastIndexOf('/') + 1, u.lastIndexOf('.'))
const mixin = TAB.map((i) => (keyOf(img) + keyOf(sub))[i]).join('').slice(0, 32)
const wts = Math.round(Date.now() / 1000)
const params = { id: dynId, features: 'itemOpusStyle', wts }
const clean = (v) => String(v).replace(/[!'()*]/g, '')
const q = Object.keys(params).sort().map((k) => `${encodeURIComponent(k)}=${encodeURIComponent(clean(params[k]))}`).join('&')
const url = `https://api.bilibili.com/x/polymer/web-dynamic/v1/detail?${q}&w_rid=${createHash('md5').update(q + mixin).digest('hex')}`
const d = await (await fetch(url, { headers: { ...baseHeaders, referer: `https://t.bilibili.com/${dynId}` } })).json()
console.log(`detail code=${d.code} ${d.message ?? ''}`)
const it = d.data?.item
if (!it) { console.error('✗ 拿不到这条动态（可能不存在 / 被删 / 需要登录）'); process.exit(4) }
console.log(`id=${it.id_str}  类型=${it.type}  作者=${it.modules?.module_author?.name} (mid ${it.modules?.module_author?.mid})`)
console.log(`发布时间=${it.modules?.module_author?.pub_time}`)
const dyn = it.modules?.module_dynamic ?? {}
const major = dyn.major
console.log(`\ntext = ${JSON.stringify(dyn.desc?.text ?? major?.opus?.summary?.text ?? null)}`)
const nodes = dyn.desc?.rich_text_nodes ?? major?.opus?.summary?.rich_text_nodes ?? []
console.log(`rich_text_nodes (${nodes.length}):`)
for (const n of nodes) {
  console.log(`  type=${n.type}  text=${JSON.stringify(n.text ?? n.orig_text)}  rid=${n.rid ?? '-'}  ` +
    (n.type === 'RICH_TEXT_NODE_TYPE_AT' ? '← @提及' : ''))
}
console.log(`\nmajor.type = ${major?.type}`)
const items = major?.draw?.items ?? major?.opus?.pics ?? []
console.log(`图片 ${items.length} 张:`)
for (const p of items) console.log(`  ${p.width}x${p.height}  ${(p.src ?? p.url)?.slice(0, 90)}`)
