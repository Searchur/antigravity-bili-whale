/**
 * CLI 核验命令 `recon`：无凭据只读探测视频 aid、评论区状态与热评氛围，供发评前预检。
 */
// 单条评论预检准备：只读操作，不使用登录凭据。
// 1. 通过公开 view 接口将 BV 号解析为评论区 oid（aid）
// 2. 拉取视频基础信息、评论区开关状态与热评氛围
// 3. 检查公开导航接口的 WBI 签名可用状态。
import { biliJson } from '../../bili/api.mjs'
import { biliHeaders } from '../../bili/cookie.mjs'
import { biliEndpoint } from '../../bili/endpoints.mjs'
import { localDay } from '../../core/local-date.mjs'

const BVID = process.argv[2]
const headers = biliHeaders(undefined, { referer: `https://www.bilibili.com/video/${BVID}/` })

const view = await biliJson('view', { headers, query: { bvid: BVID } })
if (view.code !== 0) {
  console.log(`view API code=${view.code} message=${view.message}`)
  process.exit(4)   // 2026-10-21 修（外部审计 #7）：接口失败不该 exit 0
}
const d = view.data
console.log('=== 视频 ===')
console.log(`  bvid    : ${d.bvid}`)
console.log(`  aid(oid): ${d.aid}          <- 评论要用这个，不是 BV 号`)
console.log(`  title   : ${d.title}`)
console.log(`  UP      : ${d.owner.name} (mid ${d.owner.mid})`)
console.log(`  pubdate : ${localDay(d.pubdate * 1000)}   时长 ${d.duration}s`)
console.log(`  stat    : 播放 ${d.stat.view}  弹幕 ${d.stat.danmaku}  评论 ${d.stat.reply}  点赞 ${d.stat.like}`)
console.log(`  rights  : ${JSON.stringify(d.rights)}`)
console.log(`  desc    : ${(d.desc ?? '').split('\n')[0].slice(0, 120)}`)

console.log('\n=== 评论区状态 + 热门评论（读读空气） ===')
const rep = await biliJson('comments', { headers, query: { type: 1, oid: d.aid, pn: 1, ps: 5, sort: 2 } })
console.log(`  reply API code=${rep.code} message=${rep.message}`)
if (rep.code === 0 && rep.data) {
  const r = rep.data
  console.log(`  page    : count=${r.page?.count} size=${r.page?.size}`)
  console.log(`  upperTop: ${r.upper?.top ? 'UP 置顶存在' : '无'}`)
  const list = r.replies ?? []
  console.log(`  got ${list.length} comments, top 3 by like:`)
  for (const c of list.slice(0, 3)) {
    console.log(`    [${c.like}赞] ${c.member?.uname}: ${String(c.content?.message ?? '').replace(/\n/g, ' ').slice(0, 80)}`)
  }
}

const nav = await biliJson('nav', { headers })
const keys = nav.data?.wbi_img
console.log(`\n=== WBI 签名状态（${keys?.img_url && keys?.sub_url ? '可用' : '不可用'}） ===`)

console.log('\n=== 将要构造的请求（占位符待你确认文案/@昵称） ===')
const { method, origin, path } = biliEndpoint('addComment')
console.log(`  ${method} ${origin}${path}`)
console.log(`  content-type: application/x-www-form-urlencoded`)
console.log(`  body(示意): type=1&oid=${d.aid}&message=<URL编码后的 "@昵称 你的评论">&plat=1&csrf=<bili_jct>`)
console.log(`  cookie    : SESSDATA / bili_jct / buvid3（你放进本机文件，我不看值）`)
console.log(`  headers   : UA + referer ${headers.referer}`)
