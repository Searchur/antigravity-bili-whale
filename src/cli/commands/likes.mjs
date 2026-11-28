/**
 * CLI 命令 `likes`：只读拉取近期「收到的赞」通知并支持按主人筛选。
 */
import { requestBili } from '../../bili/api.mjs'
import { biliHeaders, loadCred } from '../../bili/cookie.mjs'
// 「收到的赞」—— 谁赞了什么（2026-10-18 加，主人指出 B站客户端能看到点赞的人）
//
// 端点（实测 2026-10-18 可用）：GET x/msgfeed/like?build=0&mobi_app=web
//   返回 items[]：{ id, users:[{mid,nickname}], item:{...}, counts, like_time, notice_state }
//   —— **users 里就是点赞的人** ✓（这是评论区点赞名单拿不到、但"通知流"里给的那份）
//
// 用法:
//   node likes.mjs                最近 24 小时谁赞了她
//   node likes.mjs --hours 72     时间窗
//   node likes.mjs --owner        只看主人有没有赞（用于反馈识别）
//   node likes.mjs --json         total 为时间窗内通知总数，count 为筛选后的返回条数
import { config } from '../../config/index.mjs'

const argv = process.argv.slice(2)
const opt = {}
for (let i = 0; i < argv.length; i += 1) {
  if (argv[i].startsWith('--')) opt[argv[i].slice(2)] = argv[i + 1]?.startsWith('--') ? true : argv[++i] ?? true
}
const HOURS = Number(typeof opt.hours === 'string' ? opt.hours : 24)
const ONLY_OWNER = process.argv.includes('--owner')
const JSONOUT = process.argv.includes('--json')

const headers = biliHeaders(loadCred())

const since = Math.floor(Date.now() / 1000) - HOURS * 3600
const ownerMid = String(config().owner?.mid ?? '')
const ownerName = String(config().owner?.name ?? '')

let items = []
try {
  const j = await requestBili('notifyLikes', { headers, query: { build: 0, mobi_app: 'web' } })
  if (!j.payload) throw Error(j.message)
  if (!j.ok) { console.error(`x/msgfeed/like code=${j.code} ${j.message ?? ''}`); process.exit(3) }
  // 结构实测是 { latest:{items}, total:{cursor,items} } —— 不是 data.items ✗
  const merged = [...(j.data?.latest?.items ?? []), ...(j.data?.total?.items ?? []), ...(j.data?.items ?? [])]
  const uniq = [...new Map(merged.map((x) => [String(x.id), x])).values()]
  items = uniq.filter((x) => Number(x.like_time ?? 0) >= since)
} catch (e) {
  console.error('取【收到的赞】失败：' + String(e.message).slice(0, 160)); process.exit(3)
}

const ownerLiked = items.filter((it) => (it.users ?? []).some((u) => String(u.mid) === ownerMid))
const selected = ONLY_OWNER ? ownerLiked : items
const fmt = (t) => new Date(Number(t) * 1000).toLocaleString('zh-CN', { hour12: false })

if (JSONOUT) {
  console.log(JSON.stringify({ hours: HOURS, total: items.length, count: selected.length, ownerLiked: ownerLiked.length, items: selected }, null, 2))
  process.exit(0)
}

if (ONLY_OWNER) {
  if (ownerLiked.length) {
    console.log(`✓ 主人在近 ${HOURS} 小时赞了她 ${ownerLiked.length} 次：`)
    for (const it of selected) console.log(`  ${fmt(it.like_time)}，共 ${it.counts} 赞，${it.item?.title ?? it.item?.business_id ?? ''}`)
  } else {
    console.log(`（近 ${HOURS} 小时主人没点赞${ownerName ? ` - 主人=${ownerName}` : ''}）`)
  }
  process.exit(0)
}

console.log(`【收到的赞】近 ${HOURS} 小时 —— 共 ${items.length} 条通知`)
for (const it of items.slice(0, 20)) {
  const who = (it.users ?? []).map((u) => `${u.nickname}(mid ${u.mid})`).join(', ')
  const mine = (it.users ?? []).some((u) => String(u.mid) === ownerMid) ? ' ⭐主人' : ''
  console.log(`- ${fmt(it.like_time)}  共 ${it.counts} 赞  ← ${who}${mine}`)
  if (it.item?.title) console.log(`    ${String(it.item.title).slice(0, 60)}`)
}
