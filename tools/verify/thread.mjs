import { guardedFetch as fetch } from '../lib/traffic.mjs'
import { exactJson } from '../lib/json-exact.mjs'

const argv = process.argv.slice(2)
let TYPE = '1'
const pos = []
for (let i = 0; i < argv.length; i += 1) {
  if (argv[i] === '--type' && argv[i + 1]) { TYPE = String(argv[++i]); continue }
  if (!argv[i].startsWith('--')) pos.push(argv[i])
}
const [AID, BVID, ROOT] = pos
if (!AID || !ROOT) {
  console.error('用法: node thread.mjs <oid> <BV或-> <rootRpid> [--type 1|11|17]')
  process.exit(2)
}
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
const referer = BVID && /^BV[0-9A-Za-z]{10}$/.test(BVID) ? `https://www.bilibili.com/video/${BVID}/` : 'https://www.bilibili.com/'

async function fetchAll() {
  const all = []
  let root = null
  for (let pn = 1; pn <= 10; pn += 1) {
    const r = await fetch(`https://api.bilibili.com/x/v2/reply/reply?type=${encodeURIComponent(TYPE)}&oid=${encodeURIComponent(AID)}&root=${encodeURIComponent(ROOT)}&pn=${pn}&ps=20`, {
      headers: { 'user-agent': UA, referer, 'accept-language': 'zh-CN,zh;q=0.9' },
    })
    const j = await exactJson(r)
    if (j.code !== 0) return { code: j.code, message: j.message, data: { root, replies: all } }
    const rs = j.data?.replies ?? []
    root = root ?? j.data?.root
    all.push(...rs)
    if (rs.length < 20) break
  }
  return { code: 0, data: { root, replies: all } }
}

const d = await fetchAll()
if (d.code !== 0) { console.log(`code=${d.code} message=${d.message}`); process.exit(4) }
const root = d.data?.root
if (!root) { console.log('未找到对应线程根评论（可能已删除或坐标有误）'); process.exit(4) }
const rootId = root.rpid_str || root.rpid
console.log('=== 线程根（顶层评论） ===')
console.log(`  ${root.member?.uname ?? '(未知)'} (mid ${root.member?.mid ?? '?'})  rpid=${rootId}  rcount=${root.rcount ?? 0}`)
console.log(`  ${root.content?.message ?? ''}`)
const members = root.content?.members ?? []
if (members.length) console.log(`  @到: ${members.map((m) => `${m.uname}(mid ${m.mid})`).join(', ')}`)
console.log('')
console.log(`=== 楼中楼（${(d.data?.replies ?? []).length} 条） ===`)
for (const c of d.data?.replies ?? []) {
  const isRootAuthor = c.member?.mid && root.member?.mid && String(c.member.mid) === String(root.member.mid)
  console.log(`  [${isRootAuthor ? '楼主' : '回复'}] ${c.member?.uname ?? '(未知)'} (mid ${c.member?.mid ?? '?'})  rpid=${c.rpid_str || c.rpid}  parent=${c.parent_str || c.parent}  ${new Date((c.ctime ?? 0) * 1000).toLocaleTimeString('zh-CN')}`)
  console.log(`       ${c.content?.message ?? ''}`)
  const m2 = c.content?.members ?? []
  if (m2.length) console.log(`       @到: ${m2.map((x) => `${x.uname}(mid ${x.mid})`).join(', ')}`)
}
if (BVID && /^BV[0-9A-Za-z]{10}$/.test(BVID)) {
  console.log('')
  console.log(`线程链接: https://www.bilibili.com/video/${BVID}/#reply${rootId}`)
}
