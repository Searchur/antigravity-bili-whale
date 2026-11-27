import fs from 'node:fs'
import { dataPath } from '../../core/paths.mjs'
import { apiGet } from '../../bili/api.mjs'

const VALUE_FLAGS = new Set(['ps', 'pn', 'sort', 'max-chars'])
const argv = process.argv.slice(2)
const opt = {}
const positional = []
for (let i = 0; i < argv.length; i += 1) {
  const a = argv[i]
  if (a.startsWith('--')) {
    const eq = a.indexOf('=')
    if (eq > 2) opt[a.slice(2, eq)] = a.slice(eq + 1)
    else {
      const k = a.slice(2)
      const next = argv[i + 1]
      if (VALUE_FLAGS.has(k) && next !== undefined && !next.startsWith('--')) { opt[k] = next; i += 1 }
      else opt[k] = true
    }
  } else positional.push(a)
}
const bvid = positional.find(a => /^BV[0-9A-Za-z]{10}$/.test(a))
if (!bvid) { console.error('用法: node comments.mjs <BV> [--ps 20] [--pn 1] [--sort hot|time] [--json] [--max-chars 200]'); process.exit(2) }

const PS = Math.min(50, Math.max(1, Number(opt.ps ?? 20) || 20))
const PN = Math.max(1, Number(opt.pn ?? 1) || 1)
const SORT = String(opt.sort ?? 'hot') === 'time' ? 0 : 2
const MAXC = Math.max(40, Number(opt['max-chars'] ?? 200) || 200)
const AS_JSON = Boolean(opt.json)

let cred = {}
try { cred = JSON.parse(fs.readFileSync(dataPath('credentials.json'), 'utf8')) } catch {}
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
const cookie = cred.sessdata ? `SESSDATA=${cred.sessdata}; bili_jct=${cred.bili_jct ?? ''}; buvid3=${cred.buvid3 ?? ''}` : ''
const H = { 'user-agent': UA, referer: `https://www.bilibili.com/video/${bvid}/`, ...(cookie ? { cookie } : {}) }
const jget = u => apiGet(u, H)

const view = await jget(`https://api.bilibili.com/x/web-interface/view?bvid=${bvid}`)
if (view.code !== 0) {
  const msg = `view 失败 code=${view.code} ${view.message ?? ''}`
  if (AS_JSON) console.log(JSON.stringify({ ok: false, error: msg, bvid }, null, 2))
  else console.error(msg)
  process.exit(3)
}
const d = view.data
const aid = d.aid

const rep = await jget(`https://api.bilibili.com/x/v2/reply?type=1&oid=${aid}&sort=${SORT}&ps=${PS}&pn=${PN}`)
if (rep.code !== 0) {
  const msg = `reply 失败 code=${rep.code} ${rep.message ?? ''}`
  if (AS_JSON) console.log(JSON.stringify({ ok: false, error: msg, bvid, aid }, null, 2))
  else console.error(msg)
  process.exit(4)
}

const one = (r, tag = '') => ({
  rpid: String(r.rpid ?? ''),
  user: String(r.member?.uname ?? '匿名'),
  mid: String(r.member?.mid ?? ''),
  like: Number(r.like ?? 0),
  replies: Number(r.rcount ?? 0),
  time: r.ctime ? new Date(Number(r.ctime) * 1000).toLocaleString('zh-CN', { hour12: false }) : '',
  text: String(r.content?.message ?? '').replace(/\s+/g, ' ').trim().slice(0, MAXC),
  ...(tag ? { tag } : {}),
})

const top = [
  ...(Array.isArray(rep.data?.top) ? rep.data.top.map((r) => one(r, '置顶')) : []),
  ...(rep.data?.upper?.top ? [one(rep.data.upper.top, 'UP置顶')] : []),
]
const list = [
  ...top,
  ...(Array.isArray(rep.data?.replies) ? rep.data.replies.map((r) => one(r)) : []),
]

if (AS_JSON) {
  console.log(JSON.stringify({
    ok: true,
    bvid,
    aid,
    title: String(d.title ?? ''),
    total: Number(rep.data?.page?.count ?? d.stat?.reply ?? 0),
    sort: SORT === 2 ? 'hot' : 'time',
    page: PN,
    count: list.length,
    items: list,
  }, null, 2))
  process.exit(0)
}

console.log(`评论「${d.title}」`)
console.log(`BV=${bvid}  aid=${aid}  总评论≈${rep.data?.page?.count ?? d.stat?.reply ?? '?'}  sort=${SORT === 2 ? '热度' : '时间'}  pn=${PN}  本页 ${list.length} 条`)
if (!list.length) console.log('（这一页没有评论：可能关了评论区，或页码超了）')
for (const [i, c] of list.entries()) {
  const tag = c.tag ? `【${c.tag}】` : ''
  console.log(`\n[${i + 1}] ${tag}♥${c.like}  ${c.user}（mid ${c.mid}）  ${c.time}  rpid=${c.rpid}`)
  console.log(`    ${c.text}`)
  if (c.replies) console.log(`    └ 楼中楼 ${c.replies} 条`)
}
