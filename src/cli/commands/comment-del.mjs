import { guardedFetch as fetch } from '../../bili/traffic.mjs'
import { requireWritePreview } from '../../social/write-preview.mjs'
import { exactJson } from '../../core/json-exact.mjs'
import { config } from '../../config/index.mjs'
import { lifeStore } from '../../life/runtime.mjs'
import { loadCred, missingForWrite } from '../../bili/cred.mjs'

const argv = process.argv.slice(2)
const args = new Map()
for (let i = 0; i < argv.length; i += 1) {
  const a = argv[i]
  if (a.startsWith('--')) args.set(a.slice(2), argv[i + 1]?.startsWith('--') ? true : argv[++i] ?? true)
}
const oid = args.get('oid')
const rpid = args.get('rpid')
const bvid = args.get('bvid')
const type = String(args.get('type') ?? '1')
const isDry = args.has('dry')
const isGo = args.has('go')
if (!oid || !rpid) { console.error('需要 --oid <aid|comment_id_str> --rpid <rpid> [--type 1|11|17] [--bvid <BV>] --dry|--go'); process.exit(2) }
if (!['1', '11', '17'].includes(type)) { console.error('--type 仅支持 1 / 11 / 17'); process.exit(2) }
if (isDry === isGo) { console.error('必须且只能给一个 --dry 或 --go'); process.exit(2) }

let cred
try {
  cred = loadCred()
  const miss = missingForWrite(cred)
  if (miss.length) { console.error(`凭据不完整，缺少：${miss.join('、')}`); process.exit(3) }
} catch (e) { console.error(e.message); process.exit(3) }

const cookie = `SESSDATA=${cred.sessdata}; bili_jct=${cred.bili_jct}; buvid3=${cred.buvid3}`
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'

console.log('=== 将删除 ===')
console.log('  POST https://api.bilibili.com/x/v2/reply/del')
console.log(`  type=${type}  oid=${oid}  rpid=${rpid}  csrf=***csrf***   cookie=SESSDATA=***`)
if (bvid) console.log(`  referer=https://www.bilibili.com/video/${bvid}/`)
requireWritePreview('comment-delete', { type, oid, rpid, bvid }, { dry: isDry, credentials: cred })
if (isDry) { console.log('\n[dry] 预检通过，未删除。'); process.exit(0) }
if (config().life?.paused || lifeStore().read().settings.paused) {
  console.error('大鲸鱼主动活动已暂停，不能执行删除操作。')
  process.exit(4)
}

const r = await fetch('https://api.bilibili.com/x/v2/reply/del', {
  method: 'POST',
  headers: {
    'user-agent': UA,
    referer: bvid ? `https://www.bilibili.com/video/${bvid}/` : 'https://www.bilibili.com/',
    origin: 'https://www.bilibili.com',
    'content-type': 'application/x-www-form-urlencoded',
    cookie,
  },
  body: new URLSearchParams({ type, oid: String(oid), rpid: String(rpid), csrf: String(cred.bili_jct) }).toString(),
})
const out = await exactJson(r).catch(() => ({ code: -1, message: '非 JSON 响应' }))
const hints = { 0: '成功', '-101': '未登录', '-111': 'csrf 不对', '-403': '权限不足（不是自己的评论）', '-404': '无此项', 12022: '已经被删除了' }
console.log(`\n[go] HTTP ${r.status}  code=${out.code} ${out.message ?? ''}   ${hints[out.code] ?? ''}`)
process.exit(out.code === 0 ? 0 : 1)
